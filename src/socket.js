const jwt = require('jsonwebtoken');

// PERFECT SYNC: Enhanced room state storage
const sessions = {};

function initializeSocket(io) {
  io.on('connection', (socket) => {
    console.log(`[Socket] User connected: ${socket.id}`);

    // Verify JWT from handshake (optional; allow guests)
    let userId = null;
    let userName = null;
    let userAvatar = null;
    try {
      const token = socket.handshake.auth?.token;
      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'secret');
        userId = decoded.id;
        userName = decoded.username;
        userAvatar = decoded.avatar || null;
      }
    } catch (e) {
      console.log(`[Socket] JWT verification skipped for guest:`, e.message);
    }

    // Fallback to guest if not authenticated
    if (!userId) {
      userId = `guest_${socket.id}`;
      userName = `Guest_${Math.random().toString(36).slice(2, 6)}`;
    }

    let currentSessionId = null;

    // ====== ROOM:JOIN with MOVIE INFO ======
    socket.on('room:join', (data) => {
      const { sessionId, movie, user } = data || {};
      // If client provided a user object (guest provided name/id), prefer it for participant display
      const providedId = user && user.id ? user.id : null;
      const providedName = user && user.name ? user.name : null;

      console.log(`[Socket] User ${userId} joining session ${sessionId} with movie:`, movie, 'providedUser=', user);

      if (!sessions[sessionId]) {
        sessions[sessionId] = {
          participants: [],
          state: { 
            videoTime: 0, 
            isPlaying: false,
            lastUpdate: Date.now(),
            playbackRate: 1, // ADDED: playback speed support
            movie: movie || null,
            hostId: providedId || userId // First joiner is host; prefer provided id if present
          },
          messages: [],
          emojiReactions: []
        };
        console.log(`[Socket] Created new session ${sessionId} with host ${sessions[sessionId].state.hostId}`);
      }

      const session = sessions[sessionId];
      currentSessionId = sessionId;
      
      // FIX: Only update movie if joiner is host (match by providedId if present)
      const joiningId = providedId || userId;
      if (movie && session.state.hostId === joiningId) {
        session.state.movie = movie;
      }
      
      // Check if participant already exists
      const existingIndex = session.participants.findIndex(p => p.id === userId);
      
      if (existingIndex === -1) {
        // Add new participant, prefer provided id/name when available
        const participantId = providedId || userId;
        const participantName = providedName || userName;
        const participant = {
          id: participantId,
          name: participantName,
          avatar: userAvatar,
          socketId: socket.id,
          muted: false,
          cameraOn: true,
          isHost: session.state.hostId === participantId,
          joinedAt: Date.now()
        };
        session.participants.push(participant);
      } else {
        // Update existing participant's socket ID (reconnection)
        // Do not overwrite name if provided previously
        session.participants[existingIndex].socketId = socket.id;
        if (providedName) session.participants[existingIndex].name = providedName;
      }

      // Join socket room
      socket.join(sessionId);

      // PERFECT SYNC: Calculate current time if playing
      let currentTime = session.state.videoTime;
      if (session.state.isPlaying) {
        const elapsed = (Date.now() - session.state.lastUpdate) / 1000;
        currentTime = session.state.videoTime + (elapsed * session.state.playbackRate); // FIXED: Add playback rate
      }

      // Send FULL ROOM STATE to the new joiner
      socket.emit('room:sync', {
        videoTime: currentTime,
        isPlaying: session.state.isPlaying,
        playbackRate: session.state.playbackRate, // ADDED
        movie: session.state.movie,
        participants: session.participants,
        messages: session.messages.slice(-50),
        isHost: session.state.hostId === userId,
        hostId: session.state.hostId
      });

      // Broadcast updated participants list
      io.to(sessionId).emit('room:participants', session.participants);

      // FIX: Only broadcast movie if host is joining with a movie
      if (movie && session.state.hostId === userId) {
        io.to(sessionId).emit('room:movie:update', movie);
      }

      console.log(`[Socket] Session ${sessionId} now has ${session.participants.length} participants`);
    });

    // ====== ROOM:UPDATE MOVIE ======
    socket.on('room:movie:update', (data) => {
      const { sessionId, movie } = data;
      if (sessions[sessionId] && sessions[sessionId].state.hostId === userId) {
        sessions[sessionId].state.movie = movie;
        io.to(sessionId).emit('room:movie:update', movie);
        console.log(`[Socket] Movie updated in session ${sessionId}:`, movie.title);
      }
    });

    // ====== ROOM:LEAVE ======
    socket.on('room:leave', () => {
      if (currentSessionId && sessions[currentSessionId]) {
        const session = sessions[currentSessionId];
        session.participants = session.participants.filter((p) => p.id !== userId);

        io.to(currentSessionId).emit('room:participants', session.participants);

        // If host left, assign new host
        if (session.state.hostId === userId && session.participants.length > 0) {
          session.state.hostId = session.participants[0].id;
          session.participants[0].isHost = true;
          console.log(`[Socket] New host assigned: ${session.state.hostId}`);
        }

        if (session.participants.length === 0) {
          delete sessions[currentSessionId];
          console.log(`[Socket] Session ${currentSessionId} deleted (no participants)`);
        }

        socket.leave(currentSessionId);
        currentSessionId = null;
      }
    });

    // ====== PERFECT SYNC VIDEO EVENTS ======
    socket.on('room:video:play', (data) => {
      const { sessionId, time } = data;
      if (sessions[sessionId]) {
        sessions[sessionId].state.isPlaying = true;
        sessions[sessionId].state.videoTime = time;
        sessions[sessionId].state.lastUpdate = Date.now();
        
        // Broadcast with timestamp for perfect sync
        socket.to(sessionId).emit('room:video:play', { 
          time, 
          userId,
          at: Date.now()
        });
        console.log(`[Socket] User ${userId} played video at ${time}s in session ${sessionId}`);
      }
    });

    socket.on('room:video:pause', (data) => {
      const { sessionId, time } = data;
      if (sessions[sessionId]) {
        sessions[sessionId].state.isPlaying = false;
        sessions[sessionId].state.videoTime = time;
        sessions[sessionId].state.lastUpdate = Date.now();
        
        socket.to(sessionId).emit('room:video:pause', { 
          time, 
          userId,
          at: Date.now()
        });
        console.log(`[Socket] User ${userId} paused video at ${time}s in session ${sessionId}`);
      }
    });

    socket.on('room:video:seek', (data) => {
      const { sessionId, time } = data;
      if (sessions[sessionId]) {
        sessions[sessionId].state.videoTime = time;
        sessions[sessionId].state.lastUpdate = Date.now();
        
        socket.to(sessionId).emit('room:video:seek', { 
          time, 
          userId,
          at: Date.now()
        });
        console.log(`[Socket] User ${userId} seeked to ${time}s in session ${sessionId}`);
      }
    });

    // PERFECT SYNC: Host periodic sync
    socket.on('room:video:sync', (data) => {
      const { sessionId, time, isPlaying, playbackRate } = data; // ADDED playbackRate
      if (sessions[sessionId] && sessions[sessionId].state.hostId === userId) {
        sessions[sessionId].state.videoTime = time;
        sessions[sessionId].state.isPlaying = isPlaying;
        sessions[sessionId].state.playbackRate = playbackRate || 1;
        sessions[sessionId].state.lastUpdate = Date.now();
        
        socket.to(sessionId).emit('room:video:sync', {
          time,
          isPlaying,
          playbackRate: playbackRate || 1,
          at: Date.now(),
          hostId: userId
        });
      }
    });

    // ====== ADD MISSING EVENT HANDLERS ======
    
    // Chat message
    socket.on('room:chat:message', (data) => {
      const { sessionId, message } = data;
      if (sessions[sessionId]) {
        // Use the message from client; it already has proper formatting
        const msgData = message || {
          id: `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userId: userId,
          name: userName,
          text: message.text,
          at: new Date().toISOString()
        };
        
        sessions[sessionId].messages.push(msgData);
        io.to(sessionId).emit('room:chat:message', msgData);
      }
    });

    // Status update (mute/camera)
    socket.on('room:status', (data) => {
      const { sessionId, muted, cameraOn } = data;
      if (sessions[sessionId]) {
        const participant = sessions[sessionId].participants.find(p => p.id === userId);
        if (participant) {
          if (muted !== undefined) participant.muted = muted;
          if (cameraOn !== undefined) participant.cameraOn = cameraOn;
          io.to(sessionId).emit('room:participants', sessions[sessionId].participants);
        }
      }
    });

    // Emoji reaction
    socket.on('room:emoji:reaction', (data) => {
      const { sessionId, emoji } = data;
      if (sessions[sessionId]) {
        io.to(sessionId).emit('room:emoji:reaction', {
          userId: userId,
          name: userName,
          emoji: emoji,
          at: new Date().toISOString()
        });
      }
    });

    // Sync request (for reconnections)
    socket.on('room:sync:request', (data) => {
      const { sessionId } = data;
      if (sessions[sessionId]) {
        const session = sessions[sessionId];
        
        // Calculate current time
        let currentTime = session.state.videoTime;
        if (session.state.isPlaying) {
          const elapsed = (Date.now() - session.state.lastUpdate) / 1000;
          currentTime = session.state.videoTime + (elapsed * session.state.playbackRate);
        }
        
        socket.emit('room:sync', {
          videoTime: currentTime,
          isPlaying: session.state.isPlaying,
          playbackRate: session.state.playbackRate,
          movie: session.state.movie,
          participants: session.participants,
          messages: session.messages.slice(-50),
          isHost: session.state.hostId === userId,
          hostId: session.state.hostId
        });
      }

    });

    // Participant profile update (name, avatar)
    socket.on('room:participant:update', (data) => {
      const { sessionId, name, avatar } = data || {};
      if (!sessionId) return;
      const session = sessions[sessionId];
      if (!session) return;

      const participant = session.participants.find(p => p.socketId === socket.id || p.id === userId);
      if (!participant) {
        console.log(`[Socket] Participant not found for update in session ${sessionId}:`, { socketId: socket.id, userId, data });
        return;
      }

      if (name) participant.name = name;
      if (avatar) participant.avatar = avatar;

      // If the update belongs to this socket's user, update server-side userName/userAvatar variables
      if (participant.id === userId) {
        userName = participant.name;
        userAvatar = participant.avatar;
      }

      // Broadcast updated participants
      io.to(sessionId).emit('room:participants', session.participants);
      console.log(`[Socket] Participant updated in session ${sessionId}:`, { id: participant.id, name: participant.name, avatar: participant.avatar });
    });

    // ====== ROOM:HOST:REMOVE ======
    // Host can request removal of a participant by userId
    socket.on('room:host:remove', (data) => {
      const { sessionId, userId: targetUserId } = data || {};
      if (!sessionId || !targetUserId) return;
      const session = sessions[sessionId];
      if (!session) return;

      // Only allow host (or co-hosts if you decide) to remove participants
      const requesterId = userId;
      if (session.state.hostId !== requesterId) {
        console.log(`[Socket] Ignoring host:remove from non-host ${requesterId}`);
        return;
      }

      const target = session.participants.find((p) => p.id === targetUserId);
      if (!target) return;

      const targetSocketId = target.socketId;
      try {
        // Notify the target socket that they have been removed by host
        io.to(targetSocketId).emit('room:removed', { reason: 'removed_by_host', by: requesterId });

        // Remove participant from session
        session.participants = session.participants.filter((p) => p.id !== targetUserId && p.socketId !== targetSocketId);

        // Broadcast updated participants list to remaining users
        io.to(sessionId).emit('room:participants', session.participants);

        // Optionally disconnect the target socket to ensure they are removed
        const targetSocket = io.sockets.sockets.get(targetSocketId);
        if (targetSocket) {
          try { targetSocket.leave(sessionId); targetSocket.disconnect(true); } catch (e) { /* ignore */ }
        }
        console.log(`[Socket] Host removed user ${targetUserId} from session ${sessionId}`);
        // If session empty after removal, cleanup
        if (session.participants.length === 0) {
          delete sessions[sessionId];
          console.log(`[Socket] Session ${sessionId} deleted (no participants)`);
        }
      } catch (e) {
        console.error('[Socket] Error handling host remove', e && e.message ? e.message : e);
      }
    });

    // ====== DISCONNECT ======
    socket.on('disconnect', () => {
      console.log(`[Socket] User ${userId} disconnected`);
      if (currentSessionId && sessions[currentSessionId]) {
        const session = sessions[currentSessionId];
        session.participants = session.participants.filter((p) => p.id !== userId);
        io.to(currentSessionId).emit('room:participants', session.participants);

        // If host disconnected, assign new host
        if (session.state.hostId === userId && session.participants.length > 0) {
          session.state.hostId = session.participants[0].id;
          session.participants[0].isHost = true;
        }

        if (session.participants.length === 0) {
          delete sessions[currentSessionId];
          console.log(`[Socket] Session ${currentSessionId} deleted (no participants)`);
        }
      }
    });
  });
}

module.exports = { initializeSocket };
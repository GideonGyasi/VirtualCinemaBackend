import { Server as SocketIOServer, Socket } from 'socket.io';
import { AuthService } from './services/auth.service';
import { RoomService } from './services/room.service';
import logger from './utils/logger';
import { SocketUser, SocketEvents } from './types';

interface AuthenticatedSocket extends Socket {
  user?: SocketUser;
}

// PERFECT SYNC: Room state storage with movie support and host controls
const roomStates = new Map<string, {
  videoTime: number;
  isPlaying: boolean;
  lastUpdate: number;
  playbackRate: number;
  hostId: string | null;
  coHostIds: string[];
  bannedUserIds: string[];
  isLocked: boolean;
  isPrivate: boolean;
  maxCapacity: number | null;
  chatEnabled: boolean;
  chatSlowMode: number | null;
  lastMessageTime: Map<string, number>; // userId -> last message timestamp
  layout: string;
  participants: any[];
  messages: any[];
  movie: any | null;
  playlist: any[];
  joinRequests: any[];
  analytics: {
    activeWatchers: number;
    bufferingUsers: string[];
    syncHealth: Map<string, number>; // userId -> last sync timestamp
    engagement: {
      reactions: number;
      messages: number;
      peakViewers: number;
    };
  };
}>();

export function initializeSocket(io: SocketIOServer) {
  // Middleware for authentication
  io.use(async (socket: AuthenticatedSocket, next) => {
    try {
      const token = socket.handshake.auth.token;

      // Allow guests (users without token)
      if (!token) {
        socket.user = {
          id: `guest_${socket.id}`,
          username: `Guest_${Math.random().toString(36).slice(2, 6)}`,
          avatar: undefined
        };
        return next();
      }
      
      // Verify JWT token and load user
      const payload: any = AuthService.verifyToken(token);
      const user = await AuthService.getUserById(payload.uid);
      if (!user) throw new Error('User not found');

      socket.user = user;
      logger.info(`Socket authenticated for user: ${user.id}`);
      next();
    } catch (error) {
      logger.error('Socket authentication failed', error);
      // Still allow connection as guest
      socket.user = {
        id: `guest_${socket.id}`,
        username: `Guest_${Math.random().toString(36).slice(2, 6)}`,
        avatar: undefined
      };
      next();
    }
  });

  io.on('connection', (socket: AuthenticatedSocket) => {
    const user = socket.user!;
    logger.info(`[${socket.id}] User connected: ${user.id} (${user.username})`);

    // DEBUG: Log all incoming events
    const originalOn = socket.on;
    socket.on = function(event: string, listener: (...args: any[]) => void) {
      const wrappedListener = (...args: any[]) => {
        logger.debug(`[${socket.id}] 📥 INCOMING: ${event}`, {
          userId: user.id,
          username: user.username,
          data: args[0] ? JSON.parse(JSON.stringify(args[0])) : null,
          timestamp: new Date().toISOString()
        });
        return listener.apply(this, args);
      };
      return originalOn.call(this, event, wrappedListener);
    };

    // DEBUG: Log all outgoing events
    const originalEmit = socket.emit;
    socket.emit = function(event: string, ...args: any[]) {
      logger.debug(`[${socket.id}] 📤 OUTGOING to ${user.id}: ${event}`, {
        event,
        userId: user.id,
        username: user.username,
        data: args[0] ? JSON.parse(JSON.stringify(args[0])) : null,
        timestamp: new Date().toISOString()
      });
      return originalEmit.apply(this, [event, ...args]);
    };

    // DEBUG: Log broadcasts
    const originalTo = socket.to;
    socket.to = function(room: string) {
      const toResult = originalTo.call(this, room);
      const originalEmitTo = toResult.emit;
      toResult.emit = function(event: string, ...args: any[]) {
        logger.debug(`[${socket.id}] 📡 BROADCAST to room ${room}: ${event}`, {
          event,
          fromUser: user.id,
          fromUsername: user.username,
          data: args[0] ? JSON.parse(JSON.stringify(args[0])) : null,
          timestamp: new Date().toISOString()
        });
        return originalEmitTo.apply(this, [event, ...args]);
      };
      return toResult;
    };

    // PERFECT SYNC: Join room with full state sync including movie
    socket.on('room:join', async (data: { sessionId: string; movie?: any }) => {
      try {
        const { sessionId, movie } = data;
        
        logger.info(`[${socket.id}] 🚀 room:join received`, {
          sessionId,
          user: user.id,
          username: user.username,
          isHost: !roomStates.has(sessionId),
          movieTitle: movie?.title || 'No movie provided',
          movieId: movie?.id || 'No ID',
          movieFields: movie ? Object.keys(movie) : []
        });

        // Initialize room state if doesn't exist
        if (!roomStates.has(sessionId)) {
          roomStates.set(sessionId, {
            videoTime: 0,
            isPlaying: false,
            lastUpdate: Date.now(),
            playbackRate: 1,
            hostId: user.id, // First person is host
            coHostIds: [],
            bannedUserIds: [],
            isLocked: false,
            isPrivate: false,
            maxCapacity: null,
            chatEnabled: true,
            chatSlowMode: null,
            lastMessageTime: new Map(),
            layout: 'cinema',
            participants: [],
            messages: [],
            movie: movie || null, // Store initial movie if provided
            playlist: movie ? [movie] : [],
            joinRequests: [],
            analytics: {
              activeWatchers: 0,
              bufferingUsers: [],
              syncHealth: new Map(),
              engagement: {
                reactions: 0,
                messages: 0,
                peakViewers: 0
              }
            }
          });
          logger.info(`[${socket.id}] 🆕 Created new room ${sessionId}, host: ${user.id}`);
        }

        const roomState = roomStates.get(sessionId)!;
        
        // Check if user is banned
        if (roomState.bannedUserIds.includes(user.id)) {
          logger.warn(`[${socket.id}] 🚫 Banned user ${user.id} tried to join room ${sessionId}`);
          socket.emit('error', { message: 'You are banned from this room' });
          return;
        }
        
        // Check if room is locked
        if (roomState.isLocked && roomState.hostId !== user.id && !roomState.coHostIds.includes(user.id)) {
          logger.warn(`[${socket.id}] 🔒 User ${user.id} tried to join locked room ${sessionId}`);
          socket.emit('error', { message: 'Room is locked' });
          return;
        }
        
        // Check if room is private and requires approval
        if (roomState.isPrivate && roomState.hostId !== user.id && !roomState.coHostIds.includes(user.id)) {
          // Check if user already has a pending request
          const existingRequest = roomState.joinRequests.find((r: any) => r.userId === user.id);
          if (!existingRequest) {
            roomState.joinRequests.push({
              userId: user.id,
              userName: user.username,
              status: 'pending',
              createdAt: Date.now()
            });
            // Notify host
            const hostSocket = Array.from(io.sockets.sockets.values()).find((s: any) => s.user?.id === roomState.hostId);
            if (hostSocket) {
              hostSocket.emit('room:join:request', {
                userId: user.id,
                userName: user.username
              });
            }
            socket.emit('room:join:pending', { message: 'Join request sent to host' });
            return;
          } else if (existingRequest.status === 'rejected') {
            socket.emit('error', { message: 'Your join request was rejected' });
            return;
          } else if (existingRequest.status === 'pending') {
            socket.emit('room:join:pending', { message: 'Join request pending approval' });
            return;
          }
        }
        
        // Check capacity
        if (roomState.maxCapacity && roomState.participants.length >= roomState.maxCapacity) {
          logger.warn(`[${socket.id}] 📊 Room ${sessionId} at capacity`);
          socket.emit('error', { message: 'Room is at capacity' });
          return;
        }
        
        // Check if user is first to join (becomes host if current host left)
        if (roomState.participants.length === 0) {
          roomState.hostId = user.id;
          logger.info(`[${socket.id}] 👑 User became host (first or host left)`);
        }

        // CRITICAL FIX: Handle movie data properly
        const isHost = roomState.hostId === user.id;
        
        if (movie) {
          if (isHost) {
            // Host provides the authoritative movie data
            roomState.movie = movie;
            logger.info(`[${socket.id}] 🎬 Host updated movie data:`, {
              title: movie.title || 'Unknown',
              id: movie.id,
              fields: Object.keys(movie),
              previousTitle: roomState.movie?.title || 'None'
            });
          } else if (roomState.movie) {
            // Participant joining with partial data - log what they're missing
            const missingFields = Object.keys(roomState.movie).filter(key => !movie[key]);
            if (missingFields.length > 0) {
              logger.info(`[${socket.id}] 🎯 Participant missing fields that room has:`, {
                participantMovieId: movie.id,
                roomMovieId: roomState.movie.id,
                missingFields,
                participantHas: Object.keys(movie),
                roomHas: Object.keys(roomState.movie)
              });
            }
            // Don't override room's movie with participant's partial data
          } else if (!roomState.movie && movie.id) {
            // Room has no movie yet, but participant has at least an ID - store it
            roomState.movie = { id: movie.id, ...movie };
            logger.info(`[${socket.id}] 📝 First movie data in room from participant:`, {
              id: movie.id,
              fields: Object.keys(movie)
            });
          }
        }

        // Add participant
        const participant = {
          id: user.id,
          name: user.username,
          avatar: user.avatar,
          socketId: socket.id,
          muted: false,
          cameraOn: true,
          isHost: isHost
        };
        
        // Remove if already exists (reconnection)
        const existingIndex = roomState.participants.findIndex(p => p.id === user.id);
        if (existingIndex !== -1) {
          logger.info(`[${socket.id}] 🔄 Reconnection detected, updating socket ID`);
          roomState.participants[existingIndex].socketId = socket.id;
        } else {
          roomState.participants.push(participant);
        }

        // Join socket room
        socket.join(sessionId);

        // PERFECT SYNC: Calculate current video time accounting for elapsed time
        const currentTime = roomState.isPlaying 
          ? roomState.videoTime + (Date.now() - roomState.lastUpdate) / 1000 * roomState.playbackRate
          : roomState.videoTime;

        // CRITICAL FIX: Always send room's movie data in sync
        // This ensures participants receive full metadata from host
        const syncMovie = roomState.movie || movie;
        
        // DEBUG: Log the exact state being sent to participant
        const syncData = {
          videoTime: currentTime,
          isPlaying: roomState.isPlaying,
          playbackRate: roomState.playbackRate,
          participants: roomState.participants,
          messages: roomState.messages.slice(-50),
          isHost: participant.isHost,
          hostId: roomState.hostId,
          joinedAt: Date.now(),
          movie: syncMovie  // Use room's movie data (or fallback to incoming)
        };

        logger.info(`[${socket.id}] 📤 Sending room:sync to ${user.id}`, {
          sessionId,
          user: user.id,
          isHost: participant.isHost,
          videoTime: currentTime.toFixed(2),
          isPlaying: roomState.isPlaying,
          playbackRate: roomState.playbackRate,
          participantsCount: roomState.participants.length,
          movieSource: roomState.movie ? 'roomState (host-provided)' : 'incoming (fallback)',
          movieTitle: syncMovie?.title || 'None',
          movieId: syncMovie?.id || 'No ID',
          movieFields: syncMovie ? Object.keys(syncMovie) : [],
          syncDataSummary: {
            hasMovie: !!syncMovie,
            movieTitle: syncMovie?.title,
            participantsCount: syncData.participants.length,
            hostId: syncData.hostId,
            isHost: syncData.isHost
          }
        });

        // Send FULL STATE to the new joiner immediately (INCLUDING MOVIE)
        socket.emit('room:sync', syncData);

        // Notify all participants about the new joiner
        io.to(sessionId).emit('room:participants', roomState.participants);
        
        // Notify others that someone joined (for UI updates)
        socket.to(sessionId).emit('room:participant:joined', participant);

        logger.info(`[${socket.id}] ✅ ${user.id} joined room ${sessionId} successfully`, {
          totalParticipants: roomState.participants.length,
          participants: roomState.participants.map(p => ({
            id: p.id,
            name: p.name,
            isHost: p.isHost
          })),
          roomStateSnapshot: {
            videoTime: roomState.videoTime,
            isPlaying: roomState.isPlaying,
            lastUpdate: new Date(roomState.lastUpdate).toISOString(),
            hasMovie: !!roomState.movie,
            movieTitle: roomState.movie?.title,
            movieId: roomState.movie?.id
          }
        });

      } catch (error) {
        logger.error(`[${socket.id}] ❌ Error joining room`, error);
        socket.emit('error', { message: 'Failed to join room' });
      }
    });

    // Movie update event (host only) - for when host changes movie mid-session
    socket.on('room:movie:update', (data: { sessionId: string; movie: any }) => {
      const { sessionId, movie } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && roomState.hostId === user.id) {
        logger.info(`[${socket.id}] 🎬 Host changing movie in room ${sessionId}`, {
          from: roomState.movie?.title || 'None',
          to: movie.title || 'Unknown',
          hostId: user.id,
          participantsCount: roomState.participants.length
        });
        
        // Only host can update movie
        roomState.movie = movie;
        
        // Reset playback state for NEW movie
        roomState.videoTime = 0;
        roomState.isPlaying = false;
        roomState.lastUpdate = Date.now();
        
        // Broadcast to all participants (including host)
        io.to(sessionId).emit('room:movie:update', movie);
      } else if (roomState) {
        logger.warn(`[${socket.id}] ⚠️ Non-host tried to change movie`, {
          user: user.id,
          actualHost: roomState.hostId,
          sessionId
        });
      }
    });

    // PERFECT SYNC: Video play with timestamp
    socket.on('room:video:play', (data: { sessionId: string; time: number }) => {
      const { sessionId, time } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        // Check host permission for play control
        if (!hasHostPermission(sessionId, user.id)) {
          logger.warn(`[${socket.id}] ⚠️ Non-host ${user.id} tried to play video`);
          socket.emit('error', { message: 'Only host can control playback' });
          return;
        }
        
        logger.debug(`[${socket.id}] ▶️ Video play in room ${sessionId}`, {
          user: user.id,
          time: time.toFixed(2),
          previousState: { videoTime: roomState.videoTime, isPlaying: roomState.isPlaying }
        });
        
        // Update room state with current time
        roomState.videoTime = time;
        roomState.isPlaying = true;
        roomState.lastUpdate = Date.now();
        
        // Broadcast with timestamp for perfect sync (to others only)
        socket.to(sessionId).emit('room:video:play', {
          time,
          userId: user.id,
          at: Date.now(),
          hostTime: roomState.videoTime
        });
      }
    });

    // PERFECT SYNC: Video pause with timestamp
    socket.on('room:video:pause', (data: { sessionId: string; time: number }) => {
      const { sessionId, time } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        // Check host permission for pause control
        if (!hasHostPermission(sessionId, user.id)) {
          logger.warn(`[${socket.id}] ⚠️ Non-host ${user.id} tried to pause video`);
          socket.emit('error', { message: 'Only host can control playback' });
          return;
        }
        
        logger.debug(`[${socket.id}] ⏸️ Video pause in room ${sessionId}`, {
          user: user.id,
          time: time.toFixed(2),
          previousState: { videoTime: roomState.videoTime, isPlaying: roomState.isPlaying }
        });
        
        // Calculate exact time when paused
        roomState.videoTime = time;
        roomState.isPlaying = false;
        roomState.lastUpdate = Date.now();
        
        // Broadcast with timestamp (to others only)
        socket.to(sessionId).emit('room:video:pause', {
          time,
          userId: user.id,
          at: Date.now(),
          hostTime: roomState.videoTime
        });
      }
    });

    // PERFECT SYNC: Video seek with timestamp
    socket.on('room:video:seek', (data: { sessionId: string; time: number }) => {
      const { sessionId, time } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        // Check host permission for seek control
        if (!hasHostPermission(sessionId, user.id)) {
          logger.warn(`[${socket.id}] ⚠️ Non-host ${user.id} tried to seek video`);
          socket.emit('error', { message: 'Only host can control playback' });
          return;
        }
        
        logger.debug(`[${socket.id}] 🎯 Video seek in room ${sessionId}`, {
          user: user.id,
          from: roomState.videoTime.toFixed(2),
          to: time.toFixed(2),
          difference: (time - roomState.videoTime).toFixed(2)
        });
        
        roomState.videoTime = time;
        roomState.lastUpdate = Date.now();
        
        socket.to(sessionId).emit('room:video:seek', {
          time,
          userId: user.id,
          at: Date.now(),
          hostTime: roomState.videoTime
        });
      }
    });

    // PERFECT SYNC: Host periodic sync (only host sends this)
    socket.on('room:video:sync', (data: { sessionId: string; time: number; isPlaying: boolean; playbackRate: number }) => {
      const { sessionId, time, isPlaying, playbackRate } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        logger.debug(`[${socket.id}] 🔄 Host sync in room ${sessionId}`, {
          time: time.toFixed(2),
          isPlaying,
          playbackRate,
          participants: roomState.participants.length - 1 // excluding host
        });
        
        // Update room state from host
        roomState.videoTime = time;
        roomState.isPlaying = isPlaying;
        roomState.playbackRate = playbackRate || 1;
        roomState.lastUpdate = Date.now();
        
        // Forward sync to all non-host participants
        socket.to(sessionId).emit('room:video:sync', {
          time,
          isPlaying,
          playbackRate: playbackRate || 1,
          at: Date.now(),
          hostId: user.id
        });
      }
    });

    // Chat message event
    socket.on('room:chat:message', async (data: { sessionId: string; message: any }) => {
      try {
        const { sessionId, message } = data;
        const roomState = roomStates.get(sessionId);
        
        if (!roomState) {
          socket.emit('error', { message: 'Room not found' });
          return;
        }
        
        // Check if chat is enabled
        if (!roomState.chatEnabled) {
          socket.emit('error', { message: 'Chat is disabled' });
          return;
        }
        
        // Check slow mode
        if (roomState.chatSlowMode) {
          const lastMessageTime = roomState.lastMessageTime.get(user.id) || 0;
          const timeSinceLastMessage = Date.now() - lastMessageTime;
          if (timeSinceLastMessage < roomState.chatSlowMode * 1000) {
            const remaining = Math.ceil((roomState.chatSlowMode * 1000 - timeSinceLastMessage) / 1000);
            socket.emit('error', { message: `Slow mode: Please wait ${remaining} more second(s)` });
            return;
          }
        }
        
        const msgData = {
          id: message.id || `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          userId: user.id,
          name: user.username,
          text: message.text,
          isPinned: false,
          isDeleted: false,
          at: new Date().toISOString()
        };
        
        roomState.messages.push(msgData);
        roomState.lastMessageTime.set(user.id, Date.now());
        roomState.analytics.engagement.messages++;
        
        // Emit to all participants in the room
        io.to(sessionId).emit('room:chat:message', msgData);
      } catch (error) {
        logger.error('Error sending chat message', error);
        socket.emit('error', { message: 'Failed to send message' });
      }
    });

    // Status update (mute/camera)
    socket.on('room:status', (data: { sessionId: string; muted?: boolean; cameraOn?: boolean }) => {
      const { sessionId, muted, cameraOn } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        const participant = roomState.participants.find((p: any) => p.id === user.id);
        if (participant) {
          if (muted !== undefined) participant.muted = muted;
          if (cameraOn !== undefined) participant.cameraOn = cameraOn;
          io.to(sessionId).emit('room:participants', roomState.participants);
        }
      }
    });

    // Reaction event
    socket.on('room:emoji:reaction', (data: { sessionId: string; emoji: string }) => {
      const { sessionId, emoji } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        io.to(sessionId).emit('room:emoji:reaction', {
          userId: user.id,
          name: user.username,
          emoji,
          at: new Date().toISOString()
        });
      }
    });

    // Leave room event
    socket.on('room:leave', (data: { sessionId: string }) => {
      try {
        const { sessionId } = data;
        const roomState = roomStates.get(sessionId);
        
        if (roomState) {
          logger.info(`[${socket.id}] 👋 ${user.id} leaving room ${sessionId}`, {
            user: user.id,
            wasHost: roomState.hostId === user.id,
            participantsBefore: roomState.participants.length
          });
          
          // Remove participant
          roomState.participants = roomState.participants.filter((p: any) => p.id !== user.id);
          
          // If host left, assign new host (first participant)
          if (roomState.hostId === user.id && roomState.participants.length > 0) {
            roomState.hostId = roomState.participants[0].id;
            roomState.participants[0].isHost = true;
            logger.info(`[${socket.id}] 👑 New host assigned: ${roomState.hostId}`);
          }
          
          // Notify all participants
          io.to(sessionId).emit('room:participants', roomState.participants);
          
          // Leave socket room
          socket.leave(sessionId);
          
          // Clean up empty rooms
          if (roomState.participants.length === 0) {
            roomStates.delete(sessionId);
            logger.info(`[${socket.id}] 🗑️ Room ${sessionId} deleted (no participants)`);
          }
        }
      } catch (error) {
        logger.error('Error leaving room', error);
        socket.emit('error', { message: 'Failed to leave room' });
      }
    });

    // PERFECT SYNC: Request current state (for reconnects or late joiners)
    socket.on('room:sync:request', (data: { sessionId: string }) => {
      const { sessionId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState) {
        logger.info(`[${socket.id}] 🔄 Sync requested by ${user.id} for room ${sessionId}`);
        
        // Calculate current video time
        const currentTime = roomState.isPlaying 
          ? roomState.videoTime + (Date.now() - roomState.lastUpdate) / 1000 * roomState.playbackRate
          : roomState.videoTime;
        
        socket.emit('room:sync', {
          videoTime: currentTime,
          isPlaying: roomState.isPlaying,
          playbackRate: roomState.playbackRate,
          participants: roomState.participants,
          messages: roomState.messages.slice(-50),
          isHost: roomState.hostId === user.id,
          hostId: roomState.hostId,
          movie: roomState.movie
        });
      }
    });

    // ==================== HOST CONTROLS ====================
    
    // Helper function to check if user has host permissions
    const hasHostPermission = (sessionId: string, userId: string): boolean => {
      const roomState = roomStates.get(sessionId);
      if (!roomState) return false;
      return roomState.hostId === userId || roomState.coHostIds.includes(userId);
    };

    // Host: Restart movie
    socket.on('room:host:restart', (data: { sessionId: string }) => {
      const { sessionId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.videoTime = 0;
        roomState.isPlaying = false;
        roomState.lastUpdate = Date.now();
        
        io.to(sessionId).emit('room:host:restart', { time: 0 });
        logger.info(`[${socket.id}] 🔄 Host ${user.id} restarted movie in room ${sessionId}`);
      }
    });

    // Host: End session
    socket.on('room:host:end', (data: { sessionId: string }) => {
      const { sessionId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && roomState.hostId === user.id) { // Only main host can end
        io.to(sessionId).emit('room:host:ended', { message: 'Session ended by host' });
        roomStates.delete(sessionId);
        logger.info(`[${socket.id}] 🛑 Host ${user.id} ended room ${sessionId}`);
      }
    });

    // Host: Remove user
    socket.on('room:host:remove', (data: { sessionId: string; userId: string }) => {
      const { sessionId, userId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.participants = roomState.participants.filter((p: any) => p.id !== userId);
        const userSocket = Array.from(io.sockets.sockets.values()).find((s: any) => s.user?.id === userId);
        if (userSocket) {
          userSocket.emit('room:removed', { message: 'You were removed from the room' });
          userSocket.leave(sessionId);
        }
        io.to(sessionId).emit('room:participants', roomState.participants);
        logger.info(`[${socket.id}] 👤 Host ${user.id} removed user ${userId} from room ${sessionId}`);
      }
    });

    // Host: Ban user
    socket.on('room:host:ban', (data: { sessionId: string; userId: string }) => {
      const { sessionId, userId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        if (!roomState.bannedUserIds.includes(userId)) {
          roomState.bannedUserIds.push(userId);
        }
        roomState.participants = roomState.participants.filter((p: any) => p.id !== userId);
        const userSocket = Array.from(io.sockets.sockets.values()).find((s: any) => s.user?.id === userId);
        if (userSocket) {
          userSocket.emit('room:banned', { message: 'You were banned from this room' });
          userSocket.leave(sessionId);
        }
        io.to(sessionId).emit('room:participants', roomState.participants);
        logger.info(`[${socket.id}] 🚫 Host ${user.id} banned user ${userId} from room ${sessionId}`);
      }
    });

    // Host: Kick user (temporary removal)
    socket.on('room:host:kick', (data: { sessionId: string; userId: string }) => {
      const { sessionId, userId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.participants = roomState.participants.filter((p: any) => p.id !== userId);
        const userSocket = Array.from(io.sockets.sockets.values()).find((s: any) => s.user?.id === userId);
        if (userSocket) {
          userSocket.emit('room:kicked', { message: 'You were kicked from the room' });
          userSocket.leave(sessionId);
        }
        io.to(sessionId).emit('room:participants', roomState.participants);
        logger.info(`[${socket.id}] 👢 Host ${user.id} kicked user ${userId} from room ${sessionId}`);
      }
    });

    // Host: Mute/Unmute user
    socket.on('room:host:mute', (data: { sessionId: string; userId: string; muted: boolean }) => {
      const { sessionId, userId, muted } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        const participant = roomState.participants.find((p: any) => p.id === userId);
        if (participant) {
          participant.muted = muted;
          io.to(sessionId).emit('room:participants', roomState.participants);
          io.to(sessionId).emit('room:host:user:muted', { userId, muted });
          logger.info(`[${socket.id}] 🔇 Host ${user.id} ${muted ? 'muted' : 'unmuted'} user ${userId}`);
        }
      }
    });

    // Host: Promote to Co-Host
    socket.on('room:host:promote', (data: { sessionId: string; userId: string }) => {
      const { sessionId, userId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && roomState.hostId === user.id) { // Only main host can promote
        if (!roomState.coHostIds.includes(userId)) {
          roomState.coHostIds.push(userId);
          io.to(sessionId).emit('room:host:promoted', { userId });
          logger.info(`[${socket.id}] 👑 Host ${user.id} promoted user ${userId} to co-host`);
        }
      }
    });

    // Host: Remove Co-Host
    socket.on('room:host:demote', (data: { sessionId: string; userId: string }) => {
      const { sessionId, userId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && roomState.hostId === user.id) { // Only main host can demote
        roomState.coHostIds = roomState.coHostIds.filter(id => id !== userId);
        io.to(sessionId).emit('room:host:demoted', { userId });
        logger.info(`[${socket.id}] 👑 Host ${user.id} demoted co-host ${userId}`);
      }
    });

    // Host: Lock/Unlock room
    socket.on('room:host:lock', (data: { sessionId: string; locked: boolean }) => {
      const { sessionId, locked } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.isLocked = locked;
        io.to(sessionId).emit('room:host:locked', { locked });
        logger.info(`[${socket.id}] 🔒 Host ${user.id} ${locked ? 'locked' : 'unlocked'} room ${sessionId}`);
      }
    });

    // Host: Set room privacy
    socket.on('room:host:privacy', (data: { sessionId: string; isPrivate: boolean }) => {
      const { sessionId, isPrivate } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.isPrivate = isPrivate;
        io.to(sessionId).emit('room:host:privacy:changed', { isPrivate });
        logger.info(`[${socket.id}] 🔐 Host ${user.id} set room ${sessionId} to ${isPrivate ? 'private' : 'public'}`);
      }
    });

    // Host: Set max capacity
    socket.on('room:host:capacity', (data: { sessionId: string; maxCapacity: number | null }) => {
      const { sessionId, maxCapacity } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.maxCapacity = maxCapacity;
        io.to(sessionId).emit('room:host:capacity:changed', { maxCapacity });
        logger.info(`[${socket.id}] 📊 Host ${user.id} set room ${sessionId} capacity to ${maxCapacity || 'unlimited'}`);
      }
    });

    // Host: Enable/Disable chat
    socket.on('room:host:chat:toggle', (data: { sessionId: string; enabled: boolean }) => {
      const { sessionId, enabled } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.chatEnabled = enabled;
        io.to(sessionId).emit('room:host:chat:toggled', { enabled });
        logger.info(`[${socket.id}] 💬 Host ${user.id} ${enabled ? 'enabled' : 'disabled'} chat in room ${sessionId}`);
      }
    });

    // Host: Set chat slow mode
    socket.on('room:host:chat:slowmode', (data: { sessionId: string; seconds: number | null }) => {
      const { sessionId, seconds } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.chatSlowMode = seconds;
        io.to(sessionId).emit('room:host:chat:slowmode:changed', { seconds });
        logger.info(`[${socket.id}] 🐌 Host ${user.id} set slow mode to ${seconds || 'disabled'} in room ${sessionId}`);
      }
    });

    // Host: Delete message
    socket.on('room:host:message:delete', (data: { sessionId: string; messageId: string }) => {
      const { sessionId, messageId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        const message = roomState.messages.find((m: any) => m.id === messageId);
        if (message) {
          message.isDeleted = true;
          io.to(sessionId).emit('room:host:message:deleted', { messageId });
          logger.info(`[${socket.id}] 🗑️ Host ${user.id} deleted message ${messageId} in room ${sessionId}`);
        }
      }
    });

    // Host: Pin/Unpin message
    socket.on('room:host:message:pin', (data: { sessionId: string; messageId: string; pinned: boolean }) => {
      const { sessionId, messageId, pinned } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        const message = roomState.messages.find((m: any) => m.id === messageId);
        if (message) {
          message.isPinned = pinned;
          io.to(sessionId).emit('room:host:message:pinned', { messageId, pinned });
          logger.info(`[${socket.id}] 📌 Host ${user.id} ${pinned ? 'pinned' : 'unpinned'} message ${messageId}`);
        }
      }
    });

    // Host: Clear chat
    socket.on('room:host:chat:clear', (data: { sessionId: string }) => {
      const { sessionId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.messages = [];
        io.to(sessionId).emit('room:host:chat:cleared', {});
        logger.info(`[${socket.id}] 🧹 Host ${user.id} cleared chat in room ${sessionId}`);
      }
    });

    // Host: Change layout
    socket.on('room:host:layout', (data: { sessionId: string; layout: string }) => {
      const { sessionId, layout } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.layout = layout;
        io.to(sessionId).emit('room:host:layout:changed', { layout });
        logger.info(`[${socket.id}] 🎨 Host ${user.id} changed layout to ${layout} in room ${sessionId}`);
      }
    });

    // Host: Force fullscreen
    socket.on('room:host:fullscreen', (data: { sessionId: string; enabled: boolean }) => {
      const { sessionId, enabled } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        io.to(sessionId).emit('room:host:fullscreen', { enabled });
        logger.info(`[${socket.id}] 🖥️ Host ${user.id} ${enabled ? 'enabled' : 'disabled'} fullscreen in room ${sessionId}`);
      }
    });

    // Host: Approve/Reject join request
    socket.on('room:host:join:approve', (data: { sessionId: string; userId: string; approved: boolean }) => {
      const { sessionId, userId, approved } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        const request = roomState.joinRequests.find((r: any) => r.userId === userId);
        if (request) {
          request.status = approved ? 'approved' : 'rejected';
          const userSocket = Array.from(io.sockets.sockets.values()).find((s: any) => s.user?.id === userId);
          if (userSocket) {
            userSocket.emit('room:join:response', { approved });
            if (approved) {
              // User can now join - they'll need to emit room:join again
            }
          }
          logger.info(`[${socket.id}] ✅ Host ${user.id} ${approved ? 'approved' : 'rejected'} join request from ${userId}`);
        }
      }
    });

    // Host: Add movie to playlist
    socket.on('room:host:playlist:add', (data: { sessionId: string; movie: any }) => {
      const { sessionId, movie } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.playlist.push(movie);
        io.to(sessionId).emit('room:host:playlist:updated', { playlist: roomState.playlist });
        logger.info(`[${socket.id}] 📽️ Host ${user.id} added movie to playlist in room ${sessionId}`);
      }
    });

    // Host: Remove movie from playlist
    socket.on('room:host:playlist:remove', (data: { sessionId: string; movieId: string }) => {
      const { sessionId, movieId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.playlist = roomState.playlist.filter((m: any) => m.id !== movieId);
        io.to(sessionId).emit('room:host:playlist:updated', { playlist: roomState.playlist });
        logger.info(`[${socket.id}] 🗑️ Host ${user.id} removed movie from playlist in room ${sessionId}`);
      }
    });

    // Host: Reorder playlist
    socket.on('room:host:playlist:reorder', (data: { sessionId: string; playlist: any[] }) => {
      const { sessionId, playlist } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        roomState.playlist = playlist;
        io.to(sessionId).emit('room:host:playlist:updated', { playlist });
        logger.info(`[${socket.id}] 🔄 Host ${user.id} reordered playlist in room ${sessionId}`);
      }
    });

    // Host: Get analytics
    socket.on('room:host:analytics', (data: { sessionId: string }) => {
      const { sessionId } = data;
      const roomState = roomStates.get(sessionId);
      
      if (roomState && hasHostPermission(sessionId, user.id)) {
        // Update analytics
        roomState.analytics.activeWatchers = roomState.participants.length;
        roomState.analytics.engagement.messages = roomState.messages.length;
        roomState.analytics.engagement.peakViewers = Math.max(
  roomState.analytics.engagement.peakViewers,
  roomState.participants.length
);

        
        socket.emit('room:host:analytics:response', roomState.analytics);
        logger.info(`[${socket.id}] 📊 Host ${user.id} requested analytics for room ${sessionId}`);
      }
    });

    // Update chat message handler to check slow mode
    // (We'll modify the existing chat handler)
    
    // Handle disconnection
    socket.on('disconnect', () => {
      logger.info(`[${socket.id}] 🔌 User disconnected: ${user.id} (${user.username})`);
      
      // Find all rooms this user is in and remove them
      roomStates.forEach((roomState, sessionId) => {
        const participantIndex = roomState.participants.findIndex((p: any) => p.id === user.id);
        if (participantIndex !== -1) {
          logger.info(`[${socket.id}] 👤 Removing ${user.id} from room ${sessionId}`, {
            user: user.id,
            wasHost: roomState.hostId === user.id,
            remainingParticipants: roomState.participants.length - 1
          });
          
          // Remove participant
          roomState.participants.splice(participantIndex, 1);
          
          // If host disconnected, assign new host
          if (roomState.hostId === user.id && roomState.participants.length > 0) {
            roomState.hostId = roomState.participants[0].id;
            roomState.participants[0].isHost = true;
            logger.info(`[${socket.id}] 👑 New host assigned after disconnect: ${roomState.hostId}`);
          }
          
          // Notify others
          io.to(sessionId).emit('room:participants', roomState.participants);
          
          // Clean up empty rooms
          if (roomState.participants.length === 0) {
            roomStates.delete(sessionId);
            logger.info(`[${socket.id}] 🗑️ Room ${sessionId} deleted after disconnect`);
          }
        }
      });
    });
  });
}
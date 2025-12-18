const RoomService = require('../services/room.service');
const { asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const createRoom = asyncHandler(async (req, res) => {
  const { title, youtubeUrl, privacy } = req.body;
  const hostId = req.user && req.user.uid;
  if (!hostId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  if (!title || !youtubeUrl) return res.status(400).json({ success: false, error: 'Title and YouTube URL are required' });
  const room = await RoomService.createRoom(title, youtubeUrl, privacy || 'public', hostId);
  logger.info(`Room created: ${room.id}`);
  res.status(201).json({ success: true, data: { room } });
});

const getRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const room = await RoomService.getRoomById(roomId);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
  res.json({ success: true, data: { room } });
});

const getPublicRooms = asyncHandler(async (req, res) => {
  const rooms = await RoomService.getPublicRooms();
  res.json({ success: true, data: { rooms } });
});

const joinRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const userId = req.user && req.user.uid;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const room = await RoomService.getRoomById(roomId);
  if (!room) return res.status(404).json({ success: false, error: 'Room not found' });
  await RoomService.addParticipant(roomId, userId);
  res.json({ success: true, data: { room } });
});

const leaveRoom = asyncHandler(async (req, res) => {
  const { roomId } = req.params;
  const userId = req.user && req.user.uid;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  await RoomService.removeParticipant(roomId, userId);
  res.json({ success: true, message: 'Left room successfully' });
});

module.exports = { createRoom, getRoom, getPublicRooms, joinRoom, leaveRoom };

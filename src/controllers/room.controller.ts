import { Response } from 'express';
import type { AuthenticatedRequest } from '../types';
import { RoomService } from '../services/room.service';
import { asyncHandler, ApiResponse } from '../utils/errorHandler';
import logger from '../utils/logger';

export const createRoom = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { title, youtubeUrl, privacy } = req.body;
  const hostId = req.user?.uid;

  if (!hostId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    } as ApiResponse);
  }

  if (!title || !youtubeUrl) {
    return res.status(400).json({
      success: false,
      error: 'Title and YouTube URL are required',
    } as ApiResponse);
  }

  const room = await RoomService.createRoom(
    title,
    youtubeUrl,
    privacy || 'public',
    hostId
  );

  logger.info(`Room created: ${room.id}`);

  const response: ApiResponse = {
    success: true,
    data: { room },
  };

  res.status(201).json(response);
});

export const getRoom = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { roomId } = req.params;

  const room = await RoomService.getRoomById(roomId);

  if (!room) {
    return res.status(404).json({
      success: false,
      error: 'Room not found',
    } as ApiResponse);
  }

  const response: ApiResponse = {
    success: true,
    data: { room },
  };

  res.json(response);
});

export const getPublicRooms = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const rooms = await RoomService.getPublicRooms();

  const response: ApiResponse = {
    success: true,
    data: { rooms },
  };

  res.json(response);
});

export const joinRoom = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { roomId } = req.params;
  const userId = req.user?.uid;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    } as ApiResponse);
  }

  const room = await RoomService.getRoomById(roomId);

  if (!room) {
    return res.status(404).json({
      success: false,
      error: 'Room not found',
    } as ApiResponse);
  }

  await RoomService.addParticipant(roomId, userId);

  const response: ApiResponse = {
    success: true,
    data: { room },
  };

  res.json(response);
});

export const leaveRoom = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const { roomId } = req.params;
  const userId = req.user?.uid;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    } as ApiResponse);
  }

  await RoomService.removeParticipant(roomId, userId);

  const response: ApiResponse = {
    success: true,
    message: 'Left room successfully',
  };

  res.json(response);
});

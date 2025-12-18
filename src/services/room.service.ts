import prisma from '../prisma/client';
import { RoomData, MessageData } from '../types';
import logger from '../utils/logger';

export class RoomService {
  static async createRoom(
    title: string,
    youtubeUrl: string,
    privacy: 'public' | 'private',
    hostId: string
  ): Promise<RoomData> {
    try {
      // Create room using schema fields (name/movieId/isPrivate)
      const room = await prisma.room.create({
        data: {
          name: title,
          movieId: youtubeUrl,
          isPrivate: privacy === 'private',
          hostId,
        },
        include: {
          participants: true,
          messages: true,
        },
      });

      // Add host as first participant (RoomParticipant model)
      await prisma.roomParticipant.create({
        data: {
          roomId: room.id,
          userId: hostId,
        },
      });

      logger.info(`Room created: ${room.id} by user ${hostId}`);

      // Re-fetch with latest included relations for formatting
      const fullRoom = await prisma.room.findUnique({
        where: { id: room.id },
        include: { participants: true, messages: true },
      });

      return this.formatRoomData(fullRoom);
    } catch (error) {
      logger.error('Error creating room', error);
      throw error;
    }
  }

  static async getRoomById(roomId: string): Promise<RoomData | null> {
    try {
      const room = await prisma.room.findUnique({
        where: { id: roomId },
        include: {
          participants: true,
          messages: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      });

      if (!room) return null;

      return this.formatRoomData(room);
    } catch (error) {
      logger.error('Error getting room by ID', error);
      throw error;
    }
  }

  static async getPublicRooms(): Promise<RoomData[]> {
    try {
      const rooms = await prisma.room.findMany({
        where: { isPrivate: false },
        include: {
          participants: true,
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      return Promise.all(rooms.map(async room => this.formatRoomData(room)));
    } catch (error) {
      logger.error('Error getting public rooms', error);
      throw error;
    }
  }

  static async addParticipant(roomId: string, userId: string): Promise<void> {
    try {
      // Check if participant already exists
      const existingParticipant = await prisma.roomParticipant.findUnique({
        where: {
          roomId_userId: {
            roomId,
            userId,
          },
        },
      });

      if (!existingParticipant) {
        await prisma.roomParticipant.create({
          data: {
            roomId,
            userId,
          },
        });
        logger.info(`User ${userId} added to room ${roomId}`);
      }
    } catch (error) {
      logger.error('Error adding participant', error);
      throw error;
    }
  }

  static async removeParticipant(roomId: string, userId: string): Promise<void> {
    try {
      await prisma.roomParticipant.deleteMany({
        where: {
          roomId,
          userId,
        },
      });
      logger.info(`User ${userId} removed from room ${roomId}`);
    } catch (error) {
      logger.error('Error removing participant', error);
      throw error;
    }
  }

  static async addMessage(roomId: string, userId: string, message: string): Promise<MessageData> {
    try {
      // Resolve user name/email for message snapshot
      const user = await prisma.user.findUnique({ where: { id: userId } });

      const messageData = await prisma.message.create({
        data: {
          roomId,
          userId,
          userName: user?.name || 'Unknown',
          content: message,
        },
      });

      logger.info(`Message added to room ${roomId} by user ${userId}`);

      return {
        id: messageData.id,
        roomId: messageData.roomId,
        userId: messageData.userId,
        user: {
          id: user?.id || userId,
          name: user?.name || 'Unknown',
          email: user?.email || undefined,
          photoURL: user?.photoURL || undefined,
        },
        message: messageData.content,
        createdAt: messageData.createdAt,
      };
    } catch (error) {
      logger.error('Error adding message', error);
      throw error;
    }
  }

  private static async formatRoomData(room: any): Promise<RoomData> {
    // Normalize DB fields to public API shape (title, youtubeUrl, privacy string)
    const hostUser = room.hostId ? await prisma.user.findUnique({ where: { id: room.hostId } }) : null;

    // Resolve participant users in batch
    const participantUserIds = (room.participants || []).map((p: any) => p.userId).filter(Boolean);
    const participantUsers = participantUserIds.length > 0 ? await prisma.user.findMany({ where: { id: { in: participantUserIds } } }) : [];
    const participantsMap = new Map(participantUsers.map(u => [u.id, u]));

    return {
      id: room.id,
      title: room.name || '',
      youtubeUrl: room.movieId || '',
      privacy: room.isPrivate ? 'private' : 'public',
      hostId: room.hostId || '',
      host: {
        id: hostUser?.id || '',
        name: hostUser?.name || '',
        email: hostUser?.email || '',
        photoURL: hostUser?.photoURL || undefined,
      },
      participants: (room.participants || []).map((p: any) => {
        const u = participantsMap.get(p.userId);
        return {
          id: p.userId,
          name: u?.name || 'Guest',
          email: u?.email || '',
          photoURL: u?.photoURL || undefined,
        };
      }),
      createdAt: room.createdAt,
    };
  }
}

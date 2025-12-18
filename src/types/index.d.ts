import { Request } from 'express';

export interface AuthenticatedRequest extends Request {
  user?: {
    uid: string;
    email?: string;
    name?: string;
    photoURL?: string;
    role?: 'USER' | 'HOST' | 'ADMIN';
    premium?: boolean;
  };
}

export interface SocketUser {
  id: string;
  name?: string;
  email?: string;
  photoURL?: string;
  avatar?: string;
  role?: 'USER' | 'HOST' | 'ADMIN';
  premium?: boolean;
}

export interface RoomData {
  id: string;
  title: string;
  youtubeUrl: string;
  privacy: 'public' | 'private';
  hostId: string;
  host: SocketUser;
  participants: SocketUser[];
  createdAt: Date;
}

export interface MessageData {
  id: string;
  roomId: string;
  userId: string;
  user: SocketUser;
  message: string;
  createdAt: Date;
}

export interface SocketEvents {
  // Room events
  'join-room': (data: { roomId: string; user: SocketUser }) => void;
  'leave-room': (data: { roomId: string; userId: string }) => void;

  // Video control events
  'play': (data: { roomId: string; time: number }) => void;
  'pause': (data: { roomId: string; time: number }) => void;
  'seek': (data: { roomId: string; time: number }) => void;

  // Chat events
  'chat-message': (data: { roomId: string; message: string; user: SocketUser }) => void;

  // Reaction events
  'reaction': (data: { roomId: string; reaction: string; user: SocketUser }) => void;
}

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

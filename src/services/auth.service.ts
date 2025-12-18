import prisma from '../prisma/client';
import logger from '../utils/logger';
import { SocketUser } from '../types';
import bcrypt from 'bcryptjs';
import jwt, { Secret } from 'jsonwebtoken';
import { addDays } from 'date-fns';
import ms from "ms";

const JWT_SECRET: Secret = process.env.JWT_SECRET || 'change-me';
const ACCESS_TOKEN_EXPIRES_IN: ms.StringValue =
  (process.env.ACCESS_TOKEN_EXPIRES_IN as ms.StringValue) || '15m';
const REFRESH_TOKEN_DAYS = parseInt(process.env.REFRESH_TOKEN_DAYS || '7', 10);

export class AuthService {
  // Database-backed user creation for email/password auth
  static async register(username: string, email: string, password: string) {
    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        throw new Error('Email already registered');
      }

      const hashed = await bcrypt.hash(password, 10);

      const user = await prisma.user.create({
        data: {
          name: username,
          email,
          password: hashed,
          role: 'USER',
          premium: false,
        },
      });

      const accessToken = this.generateAccessToken(user);
      const refresh = await this.issueRefreshToken(user.id);

      return { user: this.mapToSocketUser(user), accessToken, refreshToken: refresh.token };
    } catch (error) {
      logger.error('Register error', error);
      throw error;
    }
  }

  static async login(email: string, password: string) {
    try {
      const user = await prisma.user.findUnique({ where: { email } });
      if (!user) throw new Error('Invalid credentials');

      const ok = await bcrypt.compare(password, user.password);
      if (!ok) throw new Error('Invalid credentials');

      const accessToken = this.generateAccessToken(user);
      const refresh = await this.issueRefreshToken(user.id);
      return { user: this.mapToSocketUser(user), accessToken, refreshToken: refresh.token };
    } catch (error) {
      logger.error('Login error', error);
      throw error;
    }
  }

  static generateAccessToken(user: any) {
    return jwt.sign(
      {
        uid: user.id,
        email: user.email,
        role: user.role,
        premium: user.premium,
      },
      JWT_SECRET as any,
      { expiresIn: ACCESS_TOKEN_EXPIRES_IN }
    );
  }

  static verifyToken(token: string) {
    try {
      const payload = jwt.verify(token, JWT_SECRET) as any;
      return payload;
    } catch (error) {
      logger.error('JWT verification failed', error);
      throw new Error('Invalid token');
    }
  }

  static async issueRefreshToken(userId: string) {
    const token = jwt.sign({ uid: userId, type: 'refresh' }, JWT_SECRET as string, {
      expiresIn: `${REFRESH_TOKEN_DAYS}d`,
    });

    const expiresAt = addDays(new Date(), REFRESH_TOKEN_DAYS);

    const record = await prisma.refreshToken.create({
      data: {
        token,
        userId,
        expiresAt,
      },
    });

    return record;
  }

  static async refresh(refreshToken: string) {
    try {
      // Validate token exists and not revoked/expired
      const tokenRecord = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });
      if (!tokenRecord || tokenRecord.revoked || tokenRecord.expiresAt < new Date()) {
        throw new Error('Invalid refresh token');
      }

      const payload = jwt.verify(refreshToken, JWT_SECRET) as any;
      if (payload.type !== 'refresh') throw new Error('Invalid refresh token');

      const user = await prisma.user.findUnique({ where: { id: payload.uid } });
      if (!user) throw new Error('User not found');

      // Rotate refresh token
      await prisma.refreshToken.update({
        where: { token: refreshToken },
        data: { revoked: true },
      });
      const newRefresh = await this.issueRefreshToken(user.id);
      const accessToken = this.generateAccessToken(user);

      return { user: this.mapToSocketUser(user), accessToken, refreshToken: newRefresh.token };
    } catch (error) {
      logger.error('Refresh error', error);
      throw error;
    }
  }

  static async revokeRefreshToken(refreshToken: string) {
    try {
      await prisma.refreshToken.updateMany({
        where: { token: refreshToken },
        data: { revoked: true },
      });
    } catch (error) {
      logger.error('Failed to revoke refresh token', error);
    }
  }

  static mapToSocketUser(user: any): SocketUser {
    return {
      id: user.id,
      username: user.name,
      photoURL: user.photoURL || undefined,
      role: user.role,
      premium: user.premium,
    };
  }

  static async getUserById(userId: string): Promise<SocketUser | null> {
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return null;
      return this.mapToSocketUser(user);
    } catch (error) {
      logger.error('Error getting user by ID', error);
      throw error;
    }
  }
}

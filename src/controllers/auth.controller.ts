import { Request, Response } from 'express';
import { AuthenticatedRequest } from '../types';
import { AuthService } from '../services/auth.service';
import { asyncHandler, ApiResponse } from '../utils/errorHandler';
import logger from '../utils/logger';


const REFRESH_COOKIE_NAME = 'vc_rt';
const isProd = process.env.NODE_ENV === 'production';
const refreshCookieOptions = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: isProd,
  path: '/auth/refresh',
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

const setRefreshCookie = (res: Response, token: string) => {
  res.cookie(REFRESH_COOKIE_NAME, token, refreshCookieOptions);
};

export const verifyToken = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    return res.status(400).json({
      success: false,
      error: 'Token is required',
    } as ApiResponse);
  }

  const payload: any = AuthService.verifyToken(token);
  const user = await AuthService.getUserById(payload.uid);

  if (!user) {
    return res.status(404).json({ success: false, error: 'User not found' } as ApiResponse);
  }

  logger.info(`User authenticated: ${user.id}`);

  const response: ApiResponse = {
    success: true,
    data: {
      user,
      token: payload,
    },
  };

  res.json(response);
});

export const register = asyncHandler(async (req: Request, res: Response) => {
  const { username, email, password } = req.body;

  if (!email || !password || !username) {
    return res.status(400).json({ success: false, error: 'username, email and password are required' } as ApiResponse);
  }

  const { user, accessToken, refreshToken } = await AuthService.register(username, email, password);
  setRefreshCookie(res, refreshToken);

  const response: ApiResponse = {
    success: true,
    data: { user, accessToken },
  };

  res.json(response);
});

export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ success: false, error: 'email and password are required' } as ApiResponse);
  }

  const { user, accessToken, refreshToken } = await AuthService.login(email, password);
  setRefreshCookie(res, refreshToken);

  const response: ApiResponse = {
    success: true,
    data: { user, accessToken },
  };

  res.json(response);
});

export const refresh = asyncHandler(async (req: Request, res: Response) => {
  const incoming = (req as any).cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
  if (!incoming) {
    return res.status(400).json({ success: false, error: 'Refresh token is required' } as ApiResponse);
  }

  const { user, accessToken, refreshToken } = await AuthService.refresh(incoming);
  setRefreshCookie(res, refreshToken);

  const response: ApiResponse = {
    success: true,
    data: { user, accessToken },
  };
  res.json(response);
});

export const logout = asyncHandler(async (req: Request, res: Response) => {
  const incoming = (req as any).cookies?.[REFRESH_COOKIE_NAME] || req.body?.refreshToken;
  if (incoming) {
    await AuthService.revokeRefreshToken(incoming);
  }

  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions);
  const response: ApiResponse = {
    success: true,
    data: { message: 'Logged out' },
  };
  res.json(response);
});

export const getProfile = asyncHandler(async (req: AuthenticatedRequest, res: Response) => {
  const userId = req.user?.uid;

  if (!userId) {
    return res.status(401).json({
      success: false,
      error: 'Unauthorized',
    } as ApiResponse);
  }

  const user = await AuthService.getUserById(userId);

  if (!user) {
    return res.status(404).json({
      success: false,
      error: 'User not found',
    } as ApiResponse);
  }

  const response: ApiResponse = {
    success: true,
    data: { user },
  };

  res.json(response);
});

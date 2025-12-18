import { Router } from 'express';
import { verifyToken, getProfile, register, login, refresh, logout } from '../controllers/auth.controller';

const router = Router();

// Auth is JWT-based (email/password). Firebase removed.

// POST /auth/register
router.post('/register', register);

// POST /auth/login
router.post('/login', login);

// POST /auth/refresh
router.post('/refresh', refresh);

// POST /auth/logout
router.post('/logout', logout);

// POST /auth/verify-token
router.post('/verify-token', verifyToken);

// GET /auth/profile
router.get('/profile', getProfile);

export default router;

const { register: registerService, login: loginService, verifyToken, getUserById } = require('../services/auth.service');
const { asyncHandler } = require('../utils/errorHandler');
const logger = require('../utils/logger');

const register = asyncHandler(async (req, res) => {
  const { username, email, password } = req.body;
  if (!email || !password || !username) return res.status(400).json({ success: false, error: 'username, email and password are required' });
  const result = await registerService(username, email, password);
  res.json({ success: true, data: result });
});

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ success: false, error: 'email and password are required' });
  const result = await loginService(email, password);
  res.json({ success: true, data: result });
});

const verify = asyncHandler(async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ success: false, error: 'Token is required' });
  const payload = verifyToken(token);
  const user = await getUserById(payload.uid);
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });
  logger.info(`User authenticated: ${user.id}`);
  res.json({ success: true, data: { user, token: payload } });
});

const getProfile = asyncHandler(async (req, res) => {
  const userId = req.user && req.user.uid;
  if (!userId) return res.status(401).json({ success: false, error: 'Unauthorized' });
  const user = await getUserById(userId);
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });
  res.json({ success: true, data: { user } });
});

module.exports = { register, login, verify, getProfile };

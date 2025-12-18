const prisma = require('../prisma/client');
const logger = require('../utils/logger');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me';

const mapToSocketUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  photoURL: user.photoURL || undefined,
});

async function register(username, email, password) {
  try {
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) throw new Error('Email already registered');

    const hashed = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({ data: { name: username, email, password: hashed } });
    const token = generateToken(user.id, user.email);
    return { user: mapToSocketUser(user), token };
  } catch (err) {
    logger.error('Register error', err);
    throw err;
  }
}

async function login(email, password) {
  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) throw new Error('Invalid credentials');

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) throw new Error('Invalid credentials');

    const token = generateToken(user.id, user.email);
    return { user: mapToSocketUser(user), token };
  } catch (err) {
    logger.error('Login error', err);
    throw err;
  }
}

function generateToken(userId, email) {
  return jwt.sign({ uid: userId, email }, JWT_SECRET, { expiresIn: '7d' });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (err) {
    logger.error('JWT verification failed', err);
    throw new Error('Invalid token');
  }
}

async function getUserById(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;
  return mapToSocketUser(user);
}

module.exports = { register, login, generateToken, verifyToken, getUserById };

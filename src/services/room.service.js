const prisma = require('../prisma/client');
const logger = require('../utils/logger');

async function createRoom({ id, name, movieId }) {
  try {
    const data = { name, movieId };
    if (id) data.id = id;
    const room = await prisma.room.create({ data });
    return room;
  } catch (err) {
    logger.error('createRoom error', err);
    throw err;
  }
}

async function getRoomById(roomId) {
  try {
    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        participants: true,
        messages: true,
      },
    });
    return room;
  } catch (err) {
    logger.error('getRoomById error', err);
    throw err;
  }
}

async function addParticipant(roomId, userId) {
  try {
    const exists = await prisma.roomParticipant.findFirst({ where: { roomId, userId } });
    if (exists) return exists;
    const part = await prisma.roomParticipant.create({ data: { roomId, userId } });
    return part;
  } catch (err) {
    logger.error('addParticipant error', err);
    throw err;
  }
}

async function removeParticipant(roomId, userId) {
  try {
    await prisma.roomParticipant.deleteMany({ where: { roomId, userId } });
    return true;
  } catch (err) {
    logger.error('removeParticipant error', err);
    throw err;
  }
}

async function addMessage(roomId, userId, content) {
  try {
    const msg = await prisma.message.create({ data: { roomId, userId, content } });
    return msg;
  } catch (err) {
    logger.error('addMessage error', err);
    throw err;
  }
}

module.exports = { createRoom, getRoomById, addParticipant, removeParticipant, addMessage };

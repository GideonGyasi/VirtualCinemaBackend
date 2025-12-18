const express = require('express');
const { register, login, verify, getProfile } = require('../controllers/auth.controller');

const router = express.Router();

router.post('/register', register);
router.post('/login', login);
router.post('/verify-token', verify);
router.get('/profile', getProfile);

module.exports = router;

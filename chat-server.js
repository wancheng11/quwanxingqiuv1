const WebSocket = require('ws');
const Redis = require('ioredis');
const mongoose = require('mongoose');
const uuid = require('uuid');

// 连接MongoDB
mongoose.connect('mongodb://localhost:27017/customer_service', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// 创建Redis客户端
const redis = new Redis();

// 消息Schema
const MessageSchema = new mongoose.Schema({
    messageId: String,
    from: String,
    to: String,
    content: String,
    type: String,
    timestamp: Date,
    sessionId: String
});

const Message = mongoose.model('Message', MessageSchema);

// 会话Schema
const SessionSchema = new mongoose.Schema({
    sessionId: String,
    userId: String,
    serviceId: String,
    status: String,
    startTime: Date,
    endTime: Date,
    lastActiveTime: Date
});

const Session = mongoose.model('Session', SessionSchema);

// 客服状态Schema
const ServiceStatusSchema = new mongoose.Schema({
    serviceId: String,
    status: String,
    currentSessions: Number,
    lastHeartbeat: Date
});

const ServiceStatus = mongoose.model('ServiceStatus', ServiceStatusSchema);

// 创建WebSocket服务器
const wss = new WebSocket.Server({ port: 8080 });

// 存储连接的客户端
const clients = new Map();
// 存储客服状态
const serviceStatus = new Map();
// 消息队列
const messageQueue = new Map();

// 心跳检测间隔（30秒）
const HEARTBEAT_INTERVAL = 30000;
// 心跳超时时间（90秒）
const HEARTBEAT_TIMEOUT = 90000;

// WebSocket连接处理
wss.on('connection', async (ws) => {
    const clientId = uuid.v4();
    ws.id = clientId;
    
    // 初始化连接
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });

    // 消息处理
    ws.on('message', async (data) => {
        try {
            const message = JSON.parse(data);
            
            switch(message.type) {
                case 'user_login':
                    await handleUserLogin(ws, message);
                    break;
                case 'service_login':
                    await handleServiceLogin(ws, message);
                    break;
                case 'chat_message':
                    await handleChatMessage(ws, message);
                    break;
                case 'heartbeat':
                    handleHeartbeat(ws, message);
                    break;
            }
        } catch (error) {
            console.error('Message handling error:', error);
        }
    });

    // 断开连接处理
    ws.on('close', async () => {
        await handleDisconnection(ws);
    });
});

// 用户登录处理
async function handleUserLogin(ws, message) {
    const userId = message.userId;
    clients.set(userId, ws);
    ws.userId = userId;
    
    // 创建新会话
    const session = new Session({
        sessionId: uuid.v4(),
        userId: userId,
        status: 'waiting',
        startTime: new Date(),
        lastActiveTime: new Date()
    });
    await session.save();
    
    // 分配客服
    await assignService(session);
    
    // 加载历史消息
    const history = await loadChatHistory(session.sessionId);
    ws.send(JSON.stringify({
        type: 'history',
        messages: history
    }));
}

// 客服登录处理
async function handleServiceLogin(ws, message) {
    const serviceId = message.serviceId;
    clients.set(serviceId, ws);
    ws.serviceId = serviceId;
    
    // 更新客服状态
    await ServiceStatus.findOneAndUpdate(
        { serviceId },
        {
            status: 'online',
            currentSessions: 0,
            lastHeartbeat: new Date()
        },
        { upsert: true }
    );
    
    // 获取待处理的会话
    const pendingSessions = await Session.find({ status: 'waiting' });
    ws.send(JSON.stringify({
        type: 'pending_sessions',
        sessions: pendingSessions
    }));
}

// 消息处理
async function handleChatMessage(ws, message) {
    // 保存消息到MongoDB
    const newMessage = new Message({
        messageId: uuid.v4(),
        from: message.from,
        to: message.to,
        content: message.content,
        type: message.type,
        timestamp: new Date(),
        sessionId: message.sessionId
    });
    await newMessage.save();
    
    // 添加到消息队列
    addToMessageQueue(message);
    
    // 发送消息给接收方
    const receiver = clients.get(message.to);
    if (receiver && receiver.readyState === WebSocket.OPEN) {
        receiver.send(JSON.stringify(message));
    }
    
    // 更新会话最后活动时间
    await Session.findOneAndUpdate(
        { sessionId: message.sessionId },
        { lastActiveTime: new Date() }
    );
}

// 心跳检测处理
function handleHeartbeat(ws, message) {
    ws.isAlive = true;
    if (ws.serviceId) {
        serviceStatus.get(ws.serviceId).lastHeartbeat = Date.now();
    }
}

// 断开连接处理
async function handleDisconnection(ws) {
    if (ws.serviceId) {
        // 更新客服状态
        await ServiceStatus.findOneAndUpdate(
            { serviceId: ws.serviceId },
            { status: 'offline' }
        );
        serviceStatus.delete(ws.serviceId);
    }
    
    if (ws.userId) {
        // 更新会话状态
        await Session.findOneAndUpdate(
            { userId: ws.userId, status: 'active' },
            { status: 'closed', endTime: new Date() }
        );
    }
    
    clients.delete(ws.id);
}

// 分配客服
async function assignService(session) {
    // 查找当前可用的客服
    const availableService = await ServiceStatus.findOne({
        status: 'online',
        currentSessions: { $lt: 5 } // 假设每个客服最多处理5个会话
    }).sort('currentSessions');
    
    if (availableService) {
        session.serviceId = availableService.serviceId;
        session.status = 'active';
        await session.save();
        
        // 更新客服当前会话数
        await ServiceStatus.findOneAndUpdate(
            { serviceId: availableService.serviceId },
            { $inc: { currentSessions: 1 } }
        );
        
        // 通知客服和用户
        const serviceWs = clients.get(availableService.serviceId);
        const userWs = clients.get(session.userId);
        
        if (serviceWs) {
            serviceWs.send(JSON.stringify({
                type: 'new_session',
                session: session
            }));
        }
        
        if (userWs) {
            userWs.send(JSON.stringify({
                type: 'service_assigned',
                serviceId: availableService.serviceId
            }));
        }
    }
}

// 消息队列处理
function addToMessageQueue(message) {
    const queueKey = `queue:${message.to}`;
    messageQueue.set(queueKey, [...(messageQueue.get(queueKey) || []), message]);
    processMessageQueue(message.to);
}

async function processMessageQueue(recipientId) {
    const queueKey = `queue:${recipientId}`;
    const messages = messageQueue.get(queueKey) || [];
    
    while (messages.length > 0) {
        const message = messages.shift();
        const recipient = clients.get(recipientId);
        
        if (recipient && recipient.readyState === WebSocket.OPEN) {
            recipient.send(JSON.stringify(message));
            // 将消息标记为已发送
            await Message.findOneAndUpdate(
                { messageId: message.messageId },
                { status: 'delivered' }
            );
        } else {
            // 如果接收方不在线，保留在队列中
            messages.unshift(message);
            break;
        }
    }
    
    messageQueue.set(queueKey, messages);
}

// 加载聊天历史
async function loadChatHistory(sessionId) {
    return await Message.find({ sessionId })
        .sort('timestamp')
        .limit(50); // 限制加载最近50条消息
}

// 心跳检测
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) {
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, HEARTBEAT_INTERVAL);

// 启动服务器
const server = app.listen(3000, () => {
    console.log('Chat server running on port 3000');
}); 
const express = require('express');
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');

const app = express();
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

// 数据库连接配置
const dbConfig = {
    host: 'localhost',
    user: 'root',
    password: 'your_password',
    database: 'companion_app'
};

// 创建数据库连接池
const pool = mysql.createPool(dbConfig);

// WebSocket连接管理
const clients = new Map();

// WebSocket连接处理
wss.on('connection', async (ws, req) => {
    const token = req.url.split('=')[1];  // 从URL获取token
    
    try {
        // 验证token
        const decoded = jwt.verify(token, 'your_jwt_secret');
        const userId = decoded.userId;
        
        // 保存连接
        clients.set(userId, ws);
        
        // 处理消息
        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            
            switch(data.type) {
                case 'chat':
                    await handleChatMessage(userId, data);
                    break;
                case 'customer_service':
                    await handleCustomerService(userId, data);
                    break;
                case 'heartbeat':
                    ws.send(JSON.stringify({ type: 'heartbeat' }));
                    break;
            }
        });
        
        // 处理断开连接
        ws.on('close', () => {
            clients.delete(userId);
        });
        
    } catch (error) {
        ws.close();
    }
});

// 处理聊天消息
async function handleChatMessage(senderId, data) {
    const { receiverId, content, messageType } = data;
    
    try {
        // 保存消息到数据库
        const [result] = await pool.execute(
            'INSERT INTO messages (sender_id, receiver_id, content, message_type) VALUES (?, ?, ?, ?)',
            [senderId, receiverId, content, messageType]
        );
        
        // 发送消息给接收者
        const receiverWs = clients.get(receiverId);
        if (receiverWs) {
            receiverWs.send(JSON.stringify({
                type: 'chat',
                senderId,
                content,
                messageType,
                timestamp: new Date()
            }));
        }
        
    } catch (error) {
        console.error('Error handling chat message:', error);
    }
}

// 处理客服消息
async function handleCustomerService(userId, data) {
    try {
        // 查找或创建客服会话
        let [session] = await pool.execute(
            'SELECT * FROM customer_service_sessions WHERE user_id = ? AND status = "active"',
            [userId]
        );
        
        if (!session) {
            // 分配客服
            const [csUser] = await pool.execute(
                'SELECT user_id FROM users WHERE role = "customer_service" AND status = "online" LIMIT 1'
            );
            
            if (!csUser) {
                throw new Error('No customer service available');
            }
            
            // 创建新会话
            [session] = await pool.execute(
                'INSERT INTO customer_service_sessions (user_id, cs_id, status) VALUES (?, ?, "active")',
                [userId, csUser.user_id]
            );
        }
        
        // 保存消息
        await pool.execute(
            'INSERT INTO messages (sender_id, receiver_id, content, message_type) VALUES (?, ?, ?, ?)',
            [userId, session.cs_id, data.content, data.messageType]
        );
        
        // 发送消息给客服
        const csWs = clients.get(session.cs_id);
        if (csWs) {
            csWs.send(JSON.stringify({
                type: 'customer_service',
                userId,
                content: data.content,
                messageType: data.messageType,
                timestamp: new Date()
            }));
        }
        
    } catch (error) {
        console.error('Error handling customer service message:', error);
    }
}

// API路由
app.use(express.json());

// 用户注册
app.post('/api/register', async (req, res) => {
    try {
        const { username, phone, email, password } = req.body;
        
        // 生成9位随机用户ID
        const userId = Math.floor(100000000 + Math.random() * 900000000);
        
        // 加密密码
        const hashedPassword = await bcrypt.hash(password, 10);
        
        // 保存用户信息
        await pool.execute(
            'INSERT INTO users (user_id, username, phone, email, password) VALUES (?, ?, ?, ?, ?)',
            [userId, username, phone, email, hashedPassword]
        );
        
        res.json({ success: true, userId });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// 用户登录
app.post('/api/login', async (req, res) => {
    try {
        const { account, password } = req.body;
        
        // 查询用户
        const [users] = await pool.execute(
            'SELECT * FROM users WHERE phone = ? OR email = ?',
            [account, account]
        );
        
        if (users.length === 0) {
            throw new Error('User not found');
        }
        
        const user = users[0];
        
        // 验证密码
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            throw new Error('Invalid password');
        }
        
        // 生成token
        const token = jwt.sign({ userId: user.user_id }, 'your_jwt_secret', { expiresIn: '7d' });
        
        // 更新最后登录时间
        await pool.execute(
            'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE user_id = ?',
            [user.user_id]
        );
        
        res.json({
            success: true,
            token,
            user: {
                userId: user.user_id,
                username: user.username,
                avatarUrl: user.avatar_url,
                vipLevel: user.vip_level
            }
        });
        
    } catch (error) {
        res.status(401).json({ error: error.message });
    }
});

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
}); 
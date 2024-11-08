// WebSocket连接管理
class ChatService {
    constructor() {
        this.ws = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.reconnectInterval = 3000;
    }
    
    connect() {
        const token = localStorage.getItem('token');
        if (!token) return;
        
        this.ws = new WebSocket(`ws://your-server:3000?token=${token}`);
        
        this.ws.onopen = () => {
            console.log('WebSocket connected');
            this.reconnectAttempts = 0;
            this.startHeartbeat();
        };
        
        this.ws.onmessage = (event) => {
            const data = JSON.parse(event.data);
            this.handleMessage(data);
        };
        
        this.ws.onclose = () => {
            this.stopHeartbeat();
            this.reconnect();
        };
    }
    
    reconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(), this.reconnectInterval);
        }
    }
    
    startHeartbeat() {
        this.heartbeatInterval = setInterval(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'heartbeat' }));
            }
        }, 30000);
    }
    
    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
        }
    }
    
    handleMessage(data) {
        switch(data.type) {
            case 'chat':
                this.handleChatMessage(data);
                break;
            case 'customer_service':
                this.handleCustomerServiceMessage(data);
                break;
        }
    }
    
    sendMessage(receiverId, content, messageType = 'text') {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'chat',
                receiverId,
                content,
                messageType
            }));
        }
    }
    
    sendCustomerServiceMessage(content, messageType = 'text') {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
                type: 'customer_service',
                content,
                messageType
            }));
        }
    }
}

// 初始化聊天服务
const chatService = new ChatService();
chatService.connect(); 
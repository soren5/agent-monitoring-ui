import net from 'net';
const socketPath=process.argv[2]??'data/monitor.sock';const token=process.env.NANOCLAW_MONITOR_TOKEN;if(!token)throw new Error('NANOCLAW_MONITOR_TOKEN is required');
const socket=net.createConnection(socketPath,()=>socket.write(JSON.stringify({token})+'\n'));socket.on('data',chunk=>process.stdout.write(chunk));socket.on('close',()=>process.stderr.write('monitor disconnected; displayed state is stale\n'));

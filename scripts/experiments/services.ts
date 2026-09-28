import net from 'node:net';
import { say } from './provenance.js';
import type { Recipe } from './recipe.js';

/** A running service the harness started; `stop` closes it. */
export interface Service {
  name: string;
  stop(): Promise<void>;
}

/**
 * A minimal SMTP server that accepts every message and discards it, for apps that send mail during tests which no test
 * reads (documenso). It speaks just enough SMTP for nodemailer: EHLO/HELO, AUTH, MAIL, RCPT, DATA, RSET, NOOP, QUIT.
 */
function smtpSink(port: number): Promise<Service> {
  const server = net.createServer((socket) => {
    let inData = false;
    let buffer = '';
    socket.write('220 isolate-smtp-sink ready\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('latin1');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            socket.write('250 OK: discarded\r\n');
          }
          continue;
        }
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') socket.write('250-isolate-smtp-sink\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n');
        else if (verb === 'HELO') socket.write('250 isolate-smtp-sink\r\n');
        else if (verb === 'AUTH') socket.write(line.split(' ').length > 2 || line.toUpperCase().startsWith('AUTH PLAIN') ? '235 OK\r\n' : '334 VXNlcm5hbWU6\r\n');
        else if (verb === 'DATA') {
          inData = true;
          socket.write('354 end with <CRLF>.<CRLF>\r\n');
        } else if (verb === 'QUIT') socket.end('221 bye\r\n');
        else if (/^[A-Za-z0-9+/=]+$/.test(line)) socket.write('235 OK\r\n');
        else socket.write('250 OK\r\n');
      }
    });
    socket.on('error', () => socket.destroy());
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ name: `smtp-sink:${port}`, stop: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** Starts every service a recipe lists; returns them so the caller can stop them. */
export async function startServices(recipe: Recipe): Promise<Service[]> {
  const started: Service[] = [];
  for (const service of recipe.services) {
    started.push(await smtpSink(service.port));
    say(`started ${started.at(-1)!.name}`);
  }
  return started;
}

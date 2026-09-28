const http = require('http');
for (let i = 0; i < 4; i++) {
  const port = 4100 + i;
  http.createServer((req, res) => {
    require('fs').appendFileSync(`server-${port}.log`, `${req.url}\n`);
    res.setHeader('content-type', 'text/html');
    res.end(`<h1>server-${port}</h1>`);
  }).listen(port, '127.0.0.1');
}

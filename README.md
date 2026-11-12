# BookNook Server

Express and MongoDB API for BookNook. It owns the book catalogue, cover
images, borrow records, and verifies Better Auth JWTs before serving
user-specific data.

## Requirements

- Node.js 20.9 or newer
- A MongoDB database
- The BookNook frontend running with the Better Auth JWT plugin enabled

## Setup

```bash
npm install
npm start
```

The server listens on port `5000` by default.

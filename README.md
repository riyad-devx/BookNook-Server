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

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/` | Health check |
| `GET` | `/books` | List every book |
| `GET` | `/new-arrivals` | List the newest books |
| `GET` | `/books/:id` | Book details (signed in) |
| `POST` | `/add-books` | Create a book with an optional cover |
| `GET` | `/my-books` | Books owned by the caller |
| `PATCH` | `/books/:id` | Edit a book owned by the caller |
| `DELETE` | `/books/:id` | Delete a book owned by the caller |
| `POST` | `/borrows` | Borrow one copy of a book |
| `GET` | `/borrows` | List the caller's borrows |
| `POST` | `/borrows/:id/return` | Return one of the caller's borrows |
| `GET` | `/book-image/:id` | Stream a cover image from GridFS |

## Authentication and CORS

Protected routes expect `Authorization: Bearer <jwt>`. The token is minted by
the BookNook frontend through the Better Auth JWT plugin and verified here with
the published JWKS (`EdDSA`, matching issuer and audience).

- Caller identity comes only from the verified token payload.
- Owner fields sent in a request body or query are ignored.
- Edit, delete, borrow, and return operations check ownership; a non-owner gets
  `404` instead of learning whether the record exists.
- Public book lists omit `userId` and `userEmail`; book details retain them for
  the "Added by" panel.
- CORS only allows `APP_ORIGIN`. Requests without an `Origin` header still work
  for server-to-server calls.



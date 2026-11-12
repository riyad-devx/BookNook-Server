import express from 'express'
import 'dotenv/config'
import { MongoClient, GridFSBucket, ObjectId } from "mongodb";
import multer from "multer";
import cors from "cors";
import { createRemoteJWKSet, jwtVerify } from 'jose';

const app = express()
const PORT = Number(process.env.PORT ?? 5000)

// Report missing configuration instead of failing later with a confusing
// "Cannot read properties of undefined" error.
const REQUIRED_ENV = ["MONGODB_URL", "BETTER_AUTH_URL"]
const missingEnv = REQUIRED_ENV.filter((name) => !process.env[name])

if (missingEnv.length > 0) {
  console.error(
    `Missing environment variables: ${missingEnv.join(", ")}. ` +
      "The server will start, but the features that need them will not work.",
  )
}

const AUTH_BASE_URL = (
  process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
).replace(/\/+$/, "")
const APP_ORIGIN = (process.env.APP_ORIGIN ?? AUTH_BASE_URL).replace(/\/+$/, "")
const PUBLIC_API_URL = (
  process.env.PUBLIC_API_URL ?? `http://localhost:${PORT}`
).replace(/\/+$/, "")

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    // Vercel serverless functions cap the request body at 4.5 MB.
    fileSize: 4 * 1024 * 1024,
  },
});

app.use(
  cors({
    origin(origin, callback) {
      // Same-origin browser calls and server-to-server calls are allowed;
      // any other site gets no CORS permission.
      if (!origin) {
        return callback(null, false)
      }

      return callback(null, origin === APP_ORIGIN)
    },
  }),
)
app.use(express.json())

const client = new MongoClient(process.env.MONGODB_URL);

export async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("Could not connect to MongoDB:", err);
    throw err;
  }
}

const mongoClient = await connectToMongoDB();
const db = mongoClient.db('booknook')
const destinationCollection = db.collection("destination")

const booksCollection = db.collection("books");
const borrowsCollection = db.collection("borrows");

const bucket = new GridFSBucket(db, {
  bucketName: "bookImages",
});

function uploadImage(file) {
  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(file.originalname, {
      contentType: file.mimetype,
    })

    uploadStream.on('error', reject)
    uploadStream.on('finish', () => resolve(uploadStream.id))
    uploadStream.end(file.buffer)
  })
}

const JWKS = createRemoteJWKSet(new URL(`${AUTH_BASE_URL}/api/auth/jwks`), {
  cacheMaxAge: 10 * 60 * 1000,
  cooldownDuration: 30 * 1000,
  timeoutDuration: 5 * 1000,
});

function bookToJson({ imageId, ...book }, { includeOwner = false } = {}) {
  const totalCopies = Math.max(1, Number(book.totalCopies ?? book.copies) || 1)

  const json = {
    ...book,
    _id: book._id.toString(),
    totalCopies,
    availableCopies: Math.max(0, Number(book.availableCopies ?? totalCopies)),
    image: imageId ? `/book-image/${imageId}` : null,
  }

  if (!includeOwner) {
    delete json.userId
    delete json.userEmail
  }

  return json
}

async function requireAuth(req, res, next) {
  const [scheme, token] = String(req.headers.authorization ?? "").split(" ")

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return res.status(401).send({ message: "You must be signed in to do that." })
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: AUTH_BASE_URL,
      audience: AUTH_BASE_URL,
      algorithms: ["EdDSA"],
    })

    req.auth = payload
    return next()
  } catch (error) {
    return res.status(401).send({
      message:
        error?.code === "ERR_JWT_EXPIRED"
          ? "Your session has expired. Sign in again."
          : "Invalid authentication token.",
    })
  }
}

/** The caller's id, taken only from the verified token. */
function authUserId(req) {
  return String(req.auth?.sub ?? "").trim()
}

/** The caller's email, taken only from the verified token. */
function authUserEmail(req) {
  return String(req.auth?.email ?? "").trim().toLowerCase()
}

app.post('/add-books', requireAuth, upload.single('image'), async (req, res) => {
  try {
    const data = req.body ?? {}
    const userId = authUserId(req)

    if (!userId) {
      return res.status(401).send({ message: 'You must be signed in to add a book.' })
    }

    if (!data.title?.trim()) {
      return res.status(400).send({ message: 'Book title is required' })
    }

    if (!data.author?.trim()) {
      return res.status(400).send({ message: 'Author name is required' })
    }

    const totalCopies = Math.max(1, Number(data.totalCopies ?? data.copies) || 1)

    const bookData = {
      title: data.title.trim(),
      author: data.author.trim(),
      category: data.category?.trim() || 'Others',
      totalCopies,
      availableCopies: totalCopies,
      description: (data.description ?? '').trim(),
      // Owner fields come from the verified token, never from the form body.
      userId,
      userName: String(req.auth?.name ?? '').trim(),
      userEmail: authUserEmail(req),
      createdAt: new Date(),
    }

    if (req.file) {
      bookData.imageId = await uploadImage(req.file)
    }

    const result = await booksCollection.insertOne(bookData)

    res.status(201).send(bookToJson({ ...bookData, _id: result.insertedId }))
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to add book' })
  }
})

app.get('/my-books', requireAuth, async (req, res) => {
  try {
    // The id comes from the verified token; a userId query is ignored.
    const userId = authUserId(req)

    if (!userId) {
      return res.status(401).send({ message: 'You must be signed in to view your books.' })
    }

    const books = await booksCollection
      .find({ userId })
      .sort({ _id: -1 })
      .toArray()

    res.send(books.map(bookToJson))
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to get your books' })
  }
})

app.get("/books/:id", requireAuth, async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).send({ message: "Invalid book ID" });
    }

    const book = await booksCollection.findOne({
      _id: new ObjectId(req.params.id),
    });

    if (!book) {
      return res.status(404).send({ message: "Book not found" });
    }

    res.send({
      ...bookToJson(book, { includeOwner: true }),
      imageId: book.imageId?.toString(),
      imageUrl: book.imageId
        ? `${PUBLIC_API_URL}/book-image/${book.imageId}`
        : null,
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ message: "Failed to get book" });
  }
});

app.get('/books', async (req, res) => {
  const books = await booksCollection.find({}).sort({ _id: -1 }).toArray()

  res.send(books.map(bookToJson))
})

app.get('/new-arrivals', async (req, res) => {
  try {
    const books = await booksCollection
      .find({})
      .sort({ _id: -1 })
      .limit(6)
      .toArray()

    res.send(books.map(bookToJson))
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to get new arrivals' })
  }
})

app.patch('/books/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    // Ownership is checked against the verified token.
    const userId = authUserId(req)

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid book ID' })
    }

    if (!userId) {
      return res.status(401).send({ message: 'You must be signed in to edit a book.' })
    }

    const updates = {}

    if (typeof req.body.title === 'string') {
      if (!req.body.title.trim()) {
        return res.status(400).send({ message: 'Book title is required' })
      }
      updates.title = req.body.title.trim()
    }

    if (typeof req.body.author === 'string') {
      if (!req.body.author.trim()) {
        return res.status(400).send({ message: 'Author name is required' })
      }
      updates.author = req.body.author.trim()
    }

    if (typeof req.body.category === 'string' && req.body.category.trim()) {
      updates.category = req.body.category.trim()
    }

    if (req.body.totalCopies !== undefined) {
      const currentBook = await booksCollection.findOne({
        _id: new ObjectId(id),
        userId,
      })

      if (!currentBook) {
        return res.status(404).send({ message: 'Book not found' })
      }

      const currentTotal = Math.max(
        1,
        Number(currentBook.totalCopies ?? currentBook.copies) || 1,
      )

      const currentAvailable = Math.max(
        0,
        Number(currentBook.availableCopies ?? currentTotal),
      )

      const borrowedCopies = currentTotal - currentAvailable
      const newTotal = Math.max(1, Number(req.body.totalCopies) || 1)

      if (newTotal < borrowedCopies) {
        return res.status(400).send({
          message: `${borrowedCopies} copies are currently borrowed. Choose ${borrowedCopies} or more.`,
        })
      }

      updates.totalCopies = newTotal
      updates.availableCopies = newTotal - borrowedCopies
    }

    if (typeof req.body.description === 'string') {
      updates.description = req.body.description.trim()
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).send({ message: 'Nothing to update' })
    }

    updates.updatedAt = new Date()

    const result = await booksCollection.findOneAndUpdate(
      { _id: new ObjectId(id), userId },
      { $set: updates },
      { returnDocument: 'after' },
    )

    const book = result?.value ?? result

    if (!book?._id) {
      return res.status(404).send({ message: 'Book not found' })
    }

    res.send(bookToJson(book))
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to update book' })
  }
})

app.delete('/books/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    // Ownership is checked against the verified token.
    const userId = authUserId(req)

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid book ID' })
    }

    if (!userId) {
      return res.status(401).send({ message: 'You must be signed in to delete a book.' })
    }

    const activeBorrow = await borrowsCollection.findOne({
      bookId: new ObjectId(id),
      status: 'borrowed',
    })

    if (activeBorrow) {
      return res.status(409).send({
        message: 'This book has active borrows. Return them before deleting.',
      })
    }

    const result = await booksCollection.findOneAndDelete({
      _id: new ObjectId(id),
      userId,
    })

    const book = result?.value ?? result

    if (!book?._id) {
      return res.status(404).send({ message: 'Book not found' })
    }

    if (book.imageId) {
      bucket.delete(book.imageId).catch((error) => {
        console.error('Failed to delete book image', error)
      })
    }

    res.send({ success: true, deletedId: id })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to delete book' })
  }
})

app.post('/borrows', requireAuth, async (req, res) => {
  try {
    const { bookId } = req.body ?? {}
    // The borrow always belongs to the verified caller.
    const email = authUserEmail(req)

    if (!ObjectId.isValid(bookId)) {
      return res.status(400).send({ message: 'Invalid book ID' })
    }

    if (!email) {
      return res.status(401).send({ message: 'You must be signed in to borrow a book.' })
    }

    const bookObjectId = new ObjectId(bookId)
    const book = await booksCollection.findOne({ _id: bookObjectId })

    if (!book) {
      return res.status(404).send({ message: 'Book not found' })
    }

    const alreadyBorrowed = await borrowsCollection.findOne({
      bookId: bookObjectId,
      userEmail: email,
      status: 'borrowed',
    })

    if (alreadyBorrowed) {
      return res.status(409).send({ message: 'You already borrowed this book.' })
    }

    const updatedResult = await booksCollection.findOneAndUpdate(
      { _id: bookObjectId, availableCopies: { $gt: 0 } },
      { $inc: { availableCopies: -1 } },
      { returnDocument: 'after' },
    )

    const updatedBook = updatedResult?.value ?? updatedResult

    if (!updatedBook) {
      return res.status(409).send({ message: 'Out of Stock' })
    }

    const now = new Date()

    const borrow = {
      bookId: bookObjectId,
      bookTitle: book.title,
      bookImage: book.imageId ? `/book-image/${book.imageId}` : null,
      userEmail: email,
      borrowDate: now,
      returnDate: new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000),
      status: 'borrowed',
    }

    try {
      const result = await borrowsCollection.insertOne(borrow)

      res.status(201).send({
        ...borrow,
        _id: result.insertedId.toString(),
        bookId,
        availableCopies: updatedBook.availableCopies,
      })
    } catch (error) {
      await booksCollection.updateOne(
        { _id: bookObjectId },
        { $inc: { availableCopies: 1 } },
      )

      if (error.code === 11000) {
        return res.status(409).send({ message: 'You already borrowed this book.' })
      }

      throw error
    }
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Borrow failed' })
  }
})

app.get('/borrows', requireAuth, async (req, res) => {
  try {
    // The caller can only list their own borrows.
    const email = authUserEmail(req)

    if (!email) {
      return res.status(401).send({ message: 'You must be signed in to view your borrows.' })
    }

    const borrows = await borrowsCollection
      .find({ userEmail: email })
      .sort({ borrowDate: -1 })
      .toArray()

    res.send(
      borrows.map(({ _id, bookId, ...borrow }) => ({
        ...borrow,
        _id: _id.toString(),
        bookId: bookId.toString(),
      })),
    )
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Failed to get your borrows' })
  }
})

app.post('/borrows/:id/return', requireAuth, async (req, res) => {
  try {
    const { id } = req.params
    // Only the borrower from the verified token can return the book.
    const email = authUserEmail(req)

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid borrow ID' })
    }

    if (!email) {
      return res.status(401).send({ message: 'You must be signed in to return a book.' })
    }

    const borrowObjectId = new ObjectId(id)

    const result = await borrowsCollection.findOneAndUpdate(
      { _id: borrowObjectId, userEmail: email, status: 'borrowed' },
      { $set: { status: 'returned', returnedAt: new Date() } },
      { returnDocument: 'after' },
    )

    const borrow = result?.value ?? result

    if (!borrow) {
      const existing = await borrowsCollection.findOne({ _id: borrowObjectId })

      if (!existing || existing.userEmail !== email) {
        return res.status(404).send({ message: 'Borrow record not found' })
      }

      return res.status(409).send({ message: 'This book was already returned.' })
    }

    await booksCollection.updateOne(
      {
        _id: borrow.bookId,
        $expr: { $lt: ['$availableCopies', '$totalCopies'] },
      },
      { $inc: { availableCopies: 1 } },
    )

    res.send({
      ...borrow,
      _id: borrow._id.toString(),
      bookId: borrow.bookId.toString(),
    })
  } catch (error) {
    console.error(error)
    res.status(500).send({ message: 'Return failed' })
  }
})

app.get('/book-image/:id', async (req, res) => {
  try {
    const id = new ObjectId(req.params.id)

    const [file] = await db
      .collection('bookImages.files')
      .find({ _id: id })
      .toArray()

    if (!file) {
      return res.status(404).send({ message: 'Image not found' })
    }

    res.set('Content-Type', file.contentType || 'image/jpeg')
    res.set('Cache-Control', 'public, max-age=31536000, immutable')
    bucket.openDownloadStream(id).pipe(res)
  } catch {
    res.status(400).send({ message: 'Invalid image id' })
  }
})

app.get('/', (req, res) => {
  res.send({ message: 'Server is running' })
})

const booksWithoutCopies = await booksCollection
  .find({ totalCopies: { $exists: false } })
  .toArray()

for (const book of booksWithoutCopies) {
  const totalCopies = Math.max(1, Number(book.copies) || 1)

  await booksCollection.updateOne(
    { _id: book._id },
    { $set: { totalCopies, availableCopies: totalCopies } },
  )
}

try {
  await borrowsCollection.createIndex(
    { bookId: 1, userEmail: 1 },
    { unique: true, partialFilterExpression: { status: 'borrowed' } },
  )
} catch (error) {
  console.error('Could not create borrows index', error)
}

// Vercel invokes the exported handler directly; only listen when running
// as a normal Node process.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`Server is running at ${PORT}`)
  })
}

export default app
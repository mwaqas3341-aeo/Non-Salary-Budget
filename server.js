require('dotenv').config();
const express = require('express');
const cors = require('cors');
const uploadRoutes = require('./routes/uploadRoutes');

const app = express();

// Only your GitHub Pages origin should be allowed to call this backend.
app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/finance', uploadRoutes);

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Finance backend listening on port ${port}`));

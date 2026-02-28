const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(cors({
  origin: ['https://cenzi.shop', 'https://www.cenzi.shop'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

// ==========================================
// AUTH MIDDLEWARE
// ==========================================
const authMiddleware = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET || 'cenzi_secret');
    req.admin = decoded;
    next();
  } catch {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

// ==========================================
// FILE STORAGE SERVICE
// ==========================================
const storageService = {
  saveOrderFiles: async (orderId, projectJson) => {
    const dir = path.join(__dirname, 'uploads', 'orders', orderId.toString());
    const assetsDir = path.join(dir, 'original_assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const assetPaths = [];

    if (projectJson && projectJson.nodes) {
      for (const view in projectJson.nodes) {
        const viewNodes = projectJson.nodes[view];
        for (const node of viewNodes) {
          if (node.type === 'image' && node.url && node.url.startsWith('data:')) {
            const base64Data = node.url.split(';base64,').pop();
            const extension = node.url.split(';')[0].split('/')[1] || 'png';
            const fileName = `highres_${view}_${node.id}.${extension}`;
            const filePath = path.join(assetsDir, fileName);

            fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
            assetPaths.push({
              view,
              name: fileName,
              url: `/uploads/orders/${orderId}/original_assets/${fileName}`
            });
          }
        }
      }
    }

    const jsonPath = `/uploads/orders/${orderId}/project.json`;
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(projectJson, null, 2));

    return { json: jsonPath, assets: assetPaths };
  }
};

// ==========================================
// DATABASE MODELS
// ==========================================
const Settings = mongoose.model('Settings', new mongoose.Schema({
  basePrices: { budget: Number, corporate: Number, premium: Number },
  printFees: { front: Number, back: Number, left: Number, right: Number },
  rushFee: Number,
  deliveryFee: Number,
  whatsappNumber: String,
  bankDetails: String,
  discountTiers: Array
}));

const OrderSchema = new mongoose.Schema({
  orderId: { type: String, unique: true },
  customer: {
    name: String,
    phone: String,
    address: String,
    deliveryMethod: String
  },
  design: {
    color: String,
    sizeQuantities: Object,
    style: String,
    material: String,
    projectJsonData: mongoose.Schema.Types.Mixed,
    originalAssets: Array,
    config: mongoose.Schema.Types.Mixed,
  },
  pricing: {
    perShirt: Number,
    total: Number,
    discount: Number
  },
  status: { type: String, default: 'Awaiting WhatsApp Slip' },
  notes: { type: String, default: '' },
  statusHistory: [{
    status: String,
    changedAt: { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const Order = mongoose.model('Order', OrderSchema);

// ==========================================
// API ROUTES
// ==========================================

// ── AUTH ──
app.post('/api/auth/login', (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.body.password === adminPw) {
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'cenzi_secret', { expiresIn: '7d' });
    res.json({ token });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

// ── SETTINGS ──
app.get('/api/settings', async (req, res) => {
  try {
    let s = await Settings.findOne();
    if (!s) s = await Settings.create({
      basePrices: { budget: 1500, corporate: 2500, premium: 3500 },
      printFees: { front: 800, back: 800, left: 400, right: 400 },
      rushFee: 1500,
      deliveryFee: 500,
      whatsappNumber: '94741336159',
      bankDetails: 'CENZI PRINTS\nBank: Commercial Bank\nAcc: 0987654321\nName: CENZI Prints',
      discountTiers: [{ minQty: 15, discountPercent: 5 }, { minQty: 50, discountPercent: 10 }]
    });
    res.json(s);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    const s = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true });
    res.json(s);
  } catch (err) {
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

// ── ORDERS ──
app.post('/api/orders', async (req, res) => {
  try {
    const { customer, design, pricing, projectJson } = req.body;
    const count = await Order.countDocuments();
    const orderId = `CENZI-${1000 + count + 1}`;

    const order = new Order({
      orderId,
      customer,
      design,
      pricing,
      statusHistory: [{ status: 'Awaiting WhatsApp Slip' }]
    });

    order.design.projectJsonData = projectJson;
    await order.save();

    const files = await storageService.saveOrderFiles(order._id, projectJson);
    order.design.originalAssets = files.assets;
    order.markModified('design');
    await order.save();

    res.status(201).json(order);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Order Failed' });
  }
});

// Get all orders (admin)
app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    const { status, search, page = 1, limit = 100 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const orders = await Order.find(query)
      .sort({ createdAt: -1 })
      .limit(Number(limit))
      .skip((Number(page) - 1) * Number(limit));

    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

// Get single order
app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch order' });
  }
});

// Update status
app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.status = req.body.status;
    order.statusHistory.push({ status: req.body.status, changedAt: new Date() });
    await order.save();

    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update status' });
  }
});

// Update notes
app.put('/api/orders/:id/notes', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { notes: req.body.notes },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch (err) {
    res.status(500).json({ message: 'Failed to save notes' });
  }
});

// Bulk status update
app.put('/api/orders/bulk/status', authMiddleware, async (req, res) => {
  try {
    const { orderIds, status } = req.body;
    if (!orderIds || !Array.isArray(orderIds) || !status) {
      return res.status(400).json({ message: 'Invalid payload' });
    }

    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status }, $push: { statusHistory: { status, changedAt: new Date() } } }
    );

    res.json({ updated: orderIds.length, status });
  } catch (err) {
    res.status(500).json({ message: 'Bulk update failed' });
  }
});

// Delete order
app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    // Optionally clean up files
    const orderDir = path.join(__dirname, 'uploads', 'orders', order._id.toString());
    if (fs.existsSync(orderDir)) {
      fs.rmSync(orderDir, { recursive: true, force: true });
    }

    res.json({ message: 'Order deleted', orderId: order.orderId });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete order' });
  }
});

// Analytics / Stats endpoint
app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    const [totalOrders, totalRevenue, byStatus, byMaterial] = await Promise.all([
      Order.countDocuments(),
      Order.aggregate([{ $group: { _id: null, total: { $sum: '$pricing.total' } } }]),
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.aggregate([{ $group: { _id: '$design.material', count: { $sum: 1 } } }]),
    ]);

    // Orders per last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentOrders = await Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          revenue: { $sum: '$pricing.total' }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({
      totalOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      byStatus,
      byMaterial,
      recentOrders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 5000;
mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cenzi')
  .then(() => {
    console.log(`✅ CENZI Backend connected — listening on port ${PORT}`);
    app.listen(PORT);
  })
  .catch(err => {
    console.error('❌ MongoDB connection failed:', err.message);
    process.exit(1);
  });
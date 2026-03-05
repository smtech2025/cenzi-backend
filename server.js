const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
const dbState = {
  connected: false,
  connectionError: '',
};

const allowedOrigins = [
  'https://cenzi.shop',
  'https://www.cenzi.shop',
  'http://localhost:5173',
  'http://127.0.0.1:5173',
];

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/api/uploads', express.static(path.join(__dirname, 'uploads')));

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

function requireDatabase(res) {
  if (dbState.connected) return true;

  res.status(503).json({
    message: 'Database unavailable. Check MONGO_URI or start MongoDB and retry.',
    database: {
      connected: false,
      error: dbState.connectionError || 'MongoDB connection not established',
    },
  });
  return false;
}

const storageService = {
  saveOrderFiles: async (orderId, projectJson) => {
    const dir = path.join(__dirname, 'uploads', 'orders', orderId.toString());
    const assetsDir = path.join(dir, 'original_assets');
    if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

    const assetPaths = [];

    if (projectJson?.nodes) {
      for (const view of Object.keys(projectJson.nodes)) {
        for (const node of projectJson.nodes[view]) {
          if (node.type === 'image' && node.url && node.url.startsWith('data:')) {
            const base64Data = node.url.split(';base64,').pop();
            const extension = node.url.split(';')[0].split('/')[1] || 'png';
            const fileName = `highres_${view}_${node.id}.${extension}`;
            const filePath = path.join(assetsDir, fileName);

            fs.writeFileSync(filePath, base64Data, { encoding: 'base64' });
            assetPaths.push({
              view,
              name: fileName,
              url: `/uploads/orders/${orderId}/original_assets/${fileName}`,
            });
          }
        }
      }
    }

    const jsonPath = `/uploads/orders/${orderId}/project.json`;
    fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(projectJson, null, 2));

    return { json: jsonPath, assets: assetPaths };
  },
  getOrderAssetManifest(orderDocumentId) {
    const orderDir = path.join(__dirname, 'uploads', 'orders', orderDocumentId.toString());
    const assetsDir = path.join(orderDir, 'original_assets');
    const projectPath = path.join(orderDir, 'project.json');

    const assets = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).map((fileName) => ({
          name: fileName,
          url: `/uploads/orders/${orderDocumentId}/original_assets/${fileName}`,
        }))
      : [];

    return {
      projectJson: fs.existsSync(projectPath)
        ? `/uploads/orders/${orderDocumentId}/project.json`
        : null,
      assets,
    };
  },
};

const settingsSchema = new mongoose.Schema({
  basePrices: { budget: Number, corporate: Number, premium: Number },
  printFees: { front: Number, back: Number, left: Number, right: Number },
  printSizeConfig: { maxAreaPx: Number, maxPriceLKR: Number },
  printFee: Number,
  sizePricingMap: mongoose.Schema.Types.Mixed,
  shirtColorsByCategory: mongoose.Schema.Types.Mixed,
  rushFee: Number,
  deliveryFee: Number,
  whatsappNumber: String,
  bankDetails: String,
  discountTiers: Array,
});

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String, unique: true },
    customer: {
      name: String,
      phone: String,
      address: String,
      deliveryMethod: String,
      email: String,
    },
    design: {
      color: String,
      sizeCategory: String,
      sizeUnit: String,
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
      discount: Number,
    },
    status: { type: String, default: 'Awaiting WhatsApp Slip' },
    notes: { type: String, default: '' },
    statusHistory: [
      {
        status: String,
        changedAt: { type: Date, default: Date.now },
      },
    ],
  },
  { timestamps: true }
);

const Settings = mongoose.model('Settings', settingsSchema);
const Order = mongoose.model('Order', orderSchema);

async function getOrCreateSettings() {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = await Settings.create({
      basePrices: { budget: 1500, corporate: 2500, premium: 3500 },
      printFees: { front: 800, back: 800, left: 400, right: 400 },
      printSizeConfig: { maxAreaPx: 10000, maxPriceLKR: 400 },
      printFee: 0,
      sizePricingMap: {
        '220gsm': { budget: 1500, corporate: 2500, premium: 3500 },
        '240gsm': { budget: 1800, corporate: 2800, premium: 3800 },
        '280gsm': { budget: 2100, corporate: 3100, premium: 4100 },
      },
      shirtColorsByCategory: {
        adults: [
          { name: 'Pure White', hex: '#ffffff', stroke: '#d1d5db' },
          { name: 'Onyx Black', hex: '#111827', stroke: '#000000' },
          { name: 'Navy Blue', hex: '#1e3a8a', stroke: '#172554' },
          { name: 'Heather Gray', hex: '#9ca3af', stroke: '#6b7280' },
          { name: 'Forest Green', hex: '#166534', stroke: '#14532d' },
          { name: 'Burgundy', hex: '#7f1d1d', stroke: '#6b0000' },
        ],
        teens: [
          { name: 'Sky Blue', hex: '#0ea5e9', stroke: '#0284c7' },
          { name: 'Hot Pink', hex: '#ec4899', stroke: '#be185d' },
          { name: 'Electric Purple', hex: '#a855f7', stroke: '#7c3aed' },
          { name: 'Lime Green', hex: '#84cc16', stroke: '#65a30d' },
          { name: 'Bright Orange', hex: '#f97316', stroke: '#ea580c' },
          { name: 'Pure White', hex: '#ffffff', stroke: '#d1d5db' },
        ],
        kids: [
          { name: 'Sunshine Yellow', hex: '#fbbf24', stroke: '#f59e0b' },
          { name: 'Candy Red', hex: '#ef4444', stroke: '#dc2626' },
          { name: 'Ocean Blue', hex: '#3b82f6', stroke: '#2563eb' },
          { name: 'Grass Green', hex: '#22c55e', stroke: '#16a34a' },
          { name: 'Cloud White', hex: '#f3f4f6', stroke: '#d1d5db' },
          { name: 'Coral Pink', hex: '#fb7185', stroke: '#f43f5e' },
        ],
      },
      rushFee: 1500,
      deliveryFee: 500,
      whatsappNumber: '94741336159',
      bankDetails: 'CENZI PRINTS\nBank: Commercial Bank\nAcc: 0987654321\nName: CENZI Prints',
      discountTiers: [
        { minQty: 15, discountPercent: 5 },
        { minQty: 50, discountPercent: 10 },
      ],
    });
  } else {
    let shouldSave = false;

    if (typeof settings.printFee !== 'number') {
      settings.printFee = 0;
      shouldSave = true;
    }

    if (!settings.printSizeConfig) {
      settings.printSizeConfig = { maxAreaPx: 10000, maxPriceLKR: 400 };
      shouldSave = true;
    } else if (
      settings.printSizeConfig.maxPriceLKR === undefined ||
      settings.printSizeConfig.maxPriceLKR === null ||
      settings.printSizeConfig.maxPriceLKR === 1000
    ) {
      settings.printSizeConfig.maxPriceLKR = 400;
      shouldSave = true;
    }

    if (shouldSave) {
      settings.markModified('printSizeConfig');
      await settings.save();
    }
  }

  return settings;
}

app.post('/api/auth/login', (req, res) => {
  const adminPw = process.env.ADMIN_PASSWORD || 'admin123';
  if (req.body.password === adminPw) {
    const token = jwt.sign({ role: 'admin' }, process.env.JWT_SECRET || 'cenzi_secret', {
      expiresIn: '7d',
    });
    res.json({ token });
  } else {
    res.status(401).json({ message: 'Invalid credentials' });
  }
});

app.get('/api/auth/me', authMiddleware, (req, res) => {
  res.json({ role: req.admin.role || 'admin' });
});

app.get('/api/settings', async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const settings = await getOrCreateSettings();
    res.json(settings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server Error' });
  }
});

app.put('/api/settings', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const current = await getOrCreateSettings();
    const settings = await Settings.findByIdAndUpdate(current._id, req.body, {
      new: true,
      runValidators: false,
    });
    res.json(settings);
  } catch {
    res.status(500).json({ message: 'Failed to save settings' });
  }
});

app.post('/api/orders', async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const { customer, design, pricing, projectJson } = req.body;
    const count = await Order.countDocuments();
    const orderId = `CENZI-${1000 + count + 1}`;

    const order = new Order({
      orderId,
      customer,
      design,
      pricing,
      statusHistory: [{ status: 'Awaiting WhatsApp Slip' }],
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

app.get('/api/orders', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const { status, search, page = 1, limit = 100 } = req.query;
    const query = {};

    if (status && status !== 'all') query.status = status;
    if (search) {
      query.$or = [
        { orderId: { $regex: search, $options: 'i' } },
        { 'customer.name': { $regex: search, $options: 'i' } },
        { 'customer.phone': { $regex: search, $options: 'i' } },
      ];
    }

    const [orders, total] = await Promise.all([
      Order.find(query)
        .sort({ createdAt: -1 })
        .limit(Number(limit))
        .skip((Number(page) - 1) * Number(limit)),
      Order.countDocuments(query),
    ]);

    res.json({
      items: orders,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        pages: Math.ceil(total / Number(limit)),
      },
    });
  } catch {
    res.status(500).json({ message: 'Failed to fetch orders' });
  }
});

app.get('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    res.json({
      ...order.toObject(),
      files: storageService.getOrderAssetManifest(order._id),
    });
  } catch {
    res.status(500).json({ message: 'Failed to fetch order' });
  }
});

app.get('/api/orders/:id/assets', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    res.json(storageService.getOrderAssetManifest(order._id));
  } catch {
    res.status(500).json({ message: 'Failed to fetch order assets' });
  }
});

app.put('/api/orders/:id/status', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    order.status = req.body.status;
    order.statusHistory.push({ status: req.body.status, changedAt: new Date() });
    await order.save();

    res.json(order);
  } catch {
    res.status(500).json({ message: 'Failed to update status' });
  }
});

app.put('/api/orders/:id/notes', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const order = await Order.findByIdAndUpdate(
      req.params.id,
      { notes: req.body.notes },
      { new: true }
    );

    if (!order) return res.status(404).json({ message: 'Order not found' });
    res.json(order);
  } catch {
    res.status(500).json({ message: 'Failed to save notes' });
  }
});

app.put('/api/orders/bulk/status', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const { orderIds, status } = req.body;
    if (!orderIds || !Array.isArray(orderIds) || !status) {
      return res.status(400).json({ message: 'Invalid payload' });
    }

    await Order.updateMany(
      { _id: { $in: orderIds } },
      { $set: { status }, $push: { statusHistory: { status, changedAt: new Date() } } }
    );

    res.json({ updated: orderIds.length, status });
  } catch {
    res.status(500).json({ message: 'Bulk update failed' });
  }
});

app.delete('/api/orders/:id', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const order = await Order.findByIdAndDelete(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });

    const orderDir = path.join(__dirname, 'uploads', 'orders', order._id.toString());
    if (fs.existsSync(orderDir)) {
      fs.rmSync(orderDir, { recursive: true, force: true });
    }

    res.json({ message: 'Order deleted', orderId: order.orderId });
  } catch {
    res.status(500).json({ message: 'Failed to delete order' });
  }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
  try {
    if (!requireDatabase(res)) return;
    const [totalOrders, totalRevenue, byStatus, byMaterial, pendingOrders, recentOrders] =
      await Promise.all([
        Order.countDocuments(),
        Order.aggregate([{ $group: { _id: null, total: { $sum: '$pricing.total' } } }]),
        Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
        Order.aggregate([{ $group: { _id: '$design.material', count: { $sum: 1 } } }]),
        Order.countDocuments({ status: { $nin: ['Delivered', 'Completed'] } }),
        Order.find({}).sort({ createdAt: -1 }).limit(5).select('orderId status pricing createdAt customer'),
      ]);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dailyTrend = await Order.aggregate([
      { $match: { createdAt: { $gte: sevenDaysAgo } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 },
          revenue: { $sum: '$pricing.total' },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.json({
      totalOrders,
      pendingOrders,
      totalRevenue: totalRevenue[0]?.total || 0,
      averageOrderValue: totalOrders ? (totalRevenue[0]?.total || 0) / totalOrders : 0,
      byStatus,
      byMaterial,
      dailyTrend,
      recentOrders,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch stats' });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    status: dbState.connected ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    database: {
      connected: dbState.connected,
      error: dbState.connectionError || null,
    },
  });
});

const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => {
  console.log(`CENZI backend listening on port ${PORT}`);
});

mongoose
  .connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/cenzi', {
    serverSelectionTimeoutMS: 5000,
  })
  .then(() => {
    dbState.connected = true;
    dbState.connectionError = '';
    console.log('MongoDB connected');
  })
  .catch((err) => {
    dbState.connected = false;
    dbState.connectionError = err.message;
    console.error('MongoDB connection failed:', err.message);
    console.error('Backend is running in degraded mode until MongoDB becomes available.');
  });

mongoose.connection.on('connected', () => {
  dbState.connected = true;
  dbState.connectionError = '';
});

mongoose.connection.on('disconnected', () => {
  dbState.connected = false;
  dbState.connectionError = 'MongoDB disconnected';
});

mongoose.connection.on('error', (err) => {
  dbState.connected = false;
  dbState.connectionError = err.message;
});

server.on('error', (err) => {
  console.error('Server failed to start:', err.message);
});

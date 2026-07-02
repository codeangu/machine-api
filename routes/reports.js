const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const Sale = require("../models/Sale");
const Purchase = require("../models/purchase");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const Supplier = require("../models/supplier");

// Helper: date range filter
function dateFilter(from, to) {
  if (!from && !to) return null;
  const f = {};
  if (from) f.$gte = new Date(from);
  if (to) { const d = new Date(to); d.setHours(23,59,59,999); f.$lte = d; }
  return f;
}

// GET /api/reports/summary?from=&to=
// Dashboard summary: today sales, today purchases, total debit/credit
router.get("/summary", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const uid = req.user.id;

    // Today range
    const todayStart = new Date(); todayStart.setHours(0,0,0,0);
    const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);

    const [todaySales, todayPurchases, allSales, allPurchases, customers, suppliers, lowStock] = await Promise.all([
      Sale.find({ user: uid, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      // createdAt use karte hain (sales ki tarah) — 'date' user-entered hoti hai jo UTC-midnight
      // store hoti hai aur server ke local timezone "today" window se bahar gir jaati thi
      Purchase.find({ user: uid, createdAt: { $gte: todayStart, $lte: todayEnd } }),
      Sale.find({ user: uid }),
      Purchase.find({ user: uid }),
      Customer.find({ user: uid }),
      Supplier.find({ user: uid }),
      Product.find({ user: uid })
    ]);

    res.json({
      today: {
        sales: todaySales.reduce((s, x) => s + (x.grandTotal || 0), 0),
        salesCount: todaySales.length,
        purchases: todayPurchases.reduce((s, x) => s + (x.grandTotal || 0), 0),
        purchasesCount: todayPurchases.length,
      },
      overall: {
        totalSales: allSales.reduce((s, x) => s + (x.grandTotal || 0), 0),
        totalPurchases: allPurchases.reduce((s, x) => s + (x.grandTotal || 0), 0),
        totalReceived: allSales.reduce((s, x) => s + (x.amountReceived || 0), 0),
        totalPaid: allPurchases.reduce((s, x) => s + (x.amountPaid || 0), 0),
        customerDebit: customers.reduce((s, c) => s + (c.balance || 0), 0),
        supplierCredit: suppliers.reduce((s, s2) => s + (s2.balance || 0), 0),
      },
      lowStock: lowStock
        .filter(p => (p.currentStock || 0) <= (p.minStock || 5))
        .map(p => ({ _id: p._id, productName: p.productName, model: p.model, brand: p.brand, currentStock: p.currentStock, minStock: p.minStock || 5 }))
        .sort((a, b) => a.currentStock - b.currentStock)
    });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/sales?from=&to=
router.get("/sales", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.createdAt = df;

    const sales = await Sale.find(filter)
      .populate("customer", "name phone")
      .sort({ createdAt: -1 });

    const totalSales    = sales.reduce((s, x) => s + (x.grandTotal || 0), 0);
    const totalReceived = sales.reduce((s, x) => s + (x.amountReceived || 0), 0);
    const totalDue      = totalSales - totalReceived;

    res.json({ sales, totalSales, totalReceived, totalDue });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/purchases?from=&to=
router.get("/purchases", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.date = df;

    const purchases = await Purchase.find(filter)
      .populate("supplier", "name companyName")
      .sort({ date: -1 });

    const totalPurchases = purchases.reduce((s, x) => s + (x.grandTotal || 0), 0);
    const totalPaid      = purchases.reduce((s, x) => s + (x.amountPaid || 0), 0);
    const totalDue       = totalPurchases - totalPaid;

    res.json({ purchases, totalPurchases, totalPaid, totalDue });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/stock-adjustments?from=&to=
// All manual stock / min-stock adjustments across products (audit report)
router.get("/stock-adjustments", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const { from, to } = req.query;
    const df = dateFilter(from, to);
    const filter = { user: req.user.id };
    if (df) filter.date = df;

    const logs = await StockLog.find(filter)
      .populate("product", "productName model brand barcode")
      .sort({ date: -1 });

    const totalIncrease = logs.reduce((s, l) => s + (l.change > 0 ? l.change : 0), 0);
    const totalDecrease = logs.reduce((s, l) => s + (l.change < 0 ? Math.abs(l.change) : 0), 0);

    res.json({ logs, totalIncrease, totalDecrease, count: logs.length });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// GET /api/reports/low-stock
router.get("/low-stock", auth, async (req, res) => {
  try {
    const products = await Product.find({ user: req.user.id });
    const low = products.filter(p => (p.currentStock || 0) <= (p.minStock || 5));
    res.json(low.sort((a, b) => (a.currentStock || 0) - (b.currentStock || 0)));
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

module.exports = router;

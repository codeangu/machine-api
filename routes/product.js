const express = require("express");
const router  = express.Router();
const Product = require("../models/Product");
const auth    = require("../middleware/auth");
const { isPaged, getPageParams, pagedResponse } = require("../utils/paginate");

// Chota unique 4-digit product code banata hai (per user), collision par retry
async function generateProductCode(userId) {
  for (let i = 0; i < 15; i++) {
    const code = String(Math.floor(1000 + Math.random() * 9000));
    const exists = await Product.findOne({ productCode: code, user: userId });
    if (!exists) return code;
  }
  return String(Date.now()).slice(-6); // fallback
}

// ── POST /api/product ─────────────────────────────────────────────────────
router.post("/", auth, async (req, res) => {
  try {
    const body = req.body;

    // Type check
    if (!body.type || !["single", "machine"].includes(body.type)) {
      return res.status(400).json({ msg: "Invalid product type." });
    }

    // manufacturingYear always String
    if (body.manufacturingYear != null) {
      body.manufacturingYear = String(body.manufacturingYear);
    }

    // ── Single Part ───────────────────────────────────────
// Purana "if (body.type === 'single')" wala block hata kar yeh wala paste karein:
    
    if (body.type === "single") {
      if (body.unitPrice == null) {
        return res.status(400).json({
          msg: "unitPrice is required for single part."
        });
      }

      body.unitPrice    = Number(body.unitPrice);
      body.initialStock = body.initialStock != null ? Number(body.initialStock) : 0;
      body.minStock     = body.minStock != null ? Number(body.minStock) : null;

      // ✅ YEH 2 LINES ADD KI HAIN (Zaroori hain):
      body.currentStock = body.initialStock; // Shuru ka stock set karne ke liye
      body.purchasePrice = body.unitPrice;   // Shuru ki qeemat set karne ke liye

      // Machine fields hatao (Yeh wahi purana code hai)
      body.parts       = [];
      body.serialNo    = "";
      body.condition   = "";
      body.accessories = "";
      body.printerType = "";
    }

    // ── Machine ───────────────────────────────────────────
    if (body.type === "machine") {
      if (!body.serialNo || !body.condition) {
        return res.status(400).json({
          msg: "serialNo and condition are required for machine."
        });
      }

      if (!Array.isArray(body.parts) || body.parts.length === 0) {
        return res.status(400).json({
          msg: "At least one part is required for machine."
        });
      }

      // Har part validate aur cast karo
      for (let i = 0; i < body.parts.length; i++) {
        const p = body.parts[i];

        if (!p.name || !p.sku || p.qty == null || p.unitCost == null) {
          return res.status(400).json({
            msg: `Row ${i + 1}: name, sku, qty, unitCost are all required.`
          });
        }

        body.parts[i] = {
          name:     String(p.name),
          sku:      String(p.sku),
          qty:      Number(p.qty),
          unitCost: Number(p.unitCost),
          serialNo: p.serialNo ? String(p.serialNo) : ""
        };
      }

      // Single fields hatao
      body.unitPrice    = null;
      body.initialStock = null;
      body.minStock     = null;
    }

    body.productCode = await generateProductCode(req.user.id);

    const product = new Product({ ...body, user: req.user.id });
    await product.save();

    res.status(201).json(product);

  } catch (err) {
    console.error("POST /product error:", err.message);

    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }

    res.status(500).json({ msg: err.message || "Server Error: Save failed" });
  }
});

// ── GET /api/product ──────────────────────────────────────────────────────
router.get("/", auth, async (req, res) => {
  try {
    const { search, admin, type } = req.query;

    // Admin: apne + baaki sab users ka data (role check)
    let userFilter = { user: req.user.id };
    if (admin === "true" && req.user.role === "admin") {
      userFilter = {};
    }

    // Search filter (shared by list + counts)
    const searchFilter = {};
    if (search) {
      searchFilter.$or = [
        { productName: { $regex: search, $options: "i" } },
        { model:       { $regex: search, $options: "i" } },
        { brand:       { $regex: search, $options: "i" } },
        { barcode:     search }
      ];
    }

    // Full query = user + search + (optional) type
    let query = { ...userFilter, ...searchFilter };
    if (type === "machine" || type === "single") query.type = type;

    if (!isPaged(req)) {
      const products = await Product.find(query).sort({ createdAt: -1 });
      return res.json(products);
    }

    // Paginated response with tab counts (counts ignore the type filter)
    const { page, limit, skip } = getPageParams(req);
    const countBase = { ...userFilter, ...searchFilter };
    const [data, total, all, machine, single] = await Promise.all([
      Product.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Product.countDocuments(query),
      Product.countDocuments(countBase),
      Product.countDocuments({ ...countBase, type: "machine" }),
      Product.countDocuments({ ...countBase, type: "single" })
    ]);

    res.json(pagedResponse(data, total, page, limit, { all, machine, single }));
  } catch (err) {
    console.error("GET /product error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error: Fetch failed" });
  }
});



// ── PUT /api/product/:id ──────────────────────────────────────────────────
router.put("/:id", auth, async (req, res) => {
  try {
    const body = req.body;

    if (body.manufacturingYear != null) {
      body.manufacturingYear = String(body.manufacturingYear);
    }

    if (body.type === "machine" && Array.isArray(body.parts)) {
      body.parts = body.parts.map((p) => ({
        name:     String(p.name),
        sku:      String(p.sku),
        qty:      Number(p.qty),
        unitCost: Number(p.unitCost),
        serialNo: p.serialNo ? String(p.serialNo) : ""
      }));
    }

    const updated = await Product.findOneAndUpdate(
      { _id: req.params.id, user: req.user.id },
      { $set: body },
      { new: true, runValidators: true }
    );

    if (!updated) return res.status(404).json({ msg: "Product not found." });

    res.json(updated);
  } catch (err) {
    console.error("PUT /product error:", err.message);
    if (err.name === "ValidationError") {
      const errors = Object.values(err.errors).map(e => e.message);
      return res.status(400).json({ msg: "Validation failed", errors });
    }
    res.status(500).json({ msg: err.message || "Update failed" });
  }
});


// ── GET /api/product/:id/batches — purchase batch history ──────────────────
router.get("/:id/batches", auth, async (req, res) => {
  try {
    const Purchase = require("../models/purchase");
    const batches = await Purchase.find(
      { "items.product": req.params.id, user: req.user.id },
      { purchaseNumber: 1, date: 1, supplier: 1, items: 1 }
    )
    .populate("supplier", "name companyName")
    .sort({ date: -1 });

    const result = batches.map(p => {
      const item = p.items.find(i => i.product?.toString() === req.params.id);
      return {
        batchNumber: p.purchaseNumber,
        date: p.date,
        supplier: p.supplier?.name || "—",
        quantity: item?.quantity || 0,
        purchasePrice: item?.purchasePrice || 0,
        serialNumber: item?.serialNumber || "—"
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ── POST /api/product/:id/adjust-stock — manual stock / min-stock adjustment ─
// Body: { currentStock?, minStock?, reason? }
// Records an audit entry in StockLog for every change.
router.post("/:id/adjust-stock", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const { currentStock, minStock, reason } = req.body;

    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    if (!product) return res.status(404).json({ msg: "Product not found" });

    const logs = [];
    const prevStock = product.currentStock || 0;
    const prevMin = product.minStock;

    // Current stock adjustment
    if (currentStock !== undefined && currentStock !== null && currentStock !== "") {
      const newStock = Number(currentStock);
      if (isNaN(newStock) || newStock < 0) {
        return res.status(400).json({ msg: "Stock quantity must be a valid number (0 or more)." });
      }
      if (newStock !== prevStock) {
        product.currentStock = newStock;
        logs.push({
          product: product._id,
          type: "Stock Adjustment",
          previousStock: prevStock,
          newStock: newStock,
          change: newStock - prevStock,
          previousMinStock: prevMin,
          newMinStock: prevMin,
          reason: reason || "Manual stock adjustment",
          user: req.user.id
        });
      }
    }

    // Min-stock update
    if (minStock !== undefined && minStock !== null && minStock !== "") {
      const newMin = Number(minStock);
      if (isNaN(newMin) || newMin < 0) {
        return res.status(400).json({ msg: "Minimum stock must be a valid number (0 or more)." });
      }
      if (newMin !== prevMin) {
        product.minStock = newMin;
        logs.push({
          product: product._id,
          type: "Min Stock Update",
          previousStock: product.currentStock || 0,
          newStock: product.currentStock || 0,
          change: 0,
          previousMinStock: prevMin,
          newMinStock: newMin,
          reason: reason || "Minimum stock level updated",
          user: req.user.id
        });
      }
    }

    if (logs.length === 0) {
      return res.status(400).json({ msg: "No changes detected. Enter a new stock or minimum stock value." });
    }

    await product.save();
    await StockLog.insertMany(logs);

    res.json({ msg: "Stock updated successfully", product });
  } catch (err) {
    console.error("POST /product/:id/adjust-stock error:", err.message);
    res.status(500).json({ msg: err.message || "Stock adjustment failed" });
  }
});

// ── GET /api/product/:id/stock-logs — manual adjustment history ─────────────
router.get("/:id/stock-logs", auth, async (req, res) => {
  try {
    const StockLog = require("../models/StockLog");
    const logs = await StockLog.find({ product: req.params.id, user: req.user.id }).sort({ date: -1 }).limit(50);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

// ── GET /api/product/:id (Naya Route) ──────────────────────────────────────
router.get("/:id", auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    
    if (!product) {
      return res.status(404).json({ msg: "Product not found" });
    }
    
    res.json(product);
  } catch (err) {
    console.error("GET /product/:id error:", err.message);
    if (err.kind === 'ObjectId') {
        return res.status(400).json({ msg: "Invalid ID format" });
    }
    res.status(500).json({ msg: "Server Error" });
  }
});

// ── DELETE /api/product/:id (only if not used in sale/purchase) ────────────
router.delete("/:id", auth, async (req, res) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, user: req.user.id });
    if (!product) return res.status(404).json({ msg: "Product not found" });

    const Sale = require("../models/Sale");
    const Purchase = require("../models/purchase");
    const saleUse = await Sale.countDocuments({ "items.product": req.params.id, user: req.user.id });
    const purchaseUse = await Purchase.countDocuments({ "items.product": req.params.id, user: req.user.id });

    if (saleUse > 0 || purchaseUse > 0) {
      return res.status(400).json({
        msg: "This product is already used in a sale/purchase and cannot be deleted."
      });
    }

    await product.deleteOne();
    res.json({ msg: "Product deleted successfully" });
  } catch (err) {
    console.error("DELETE /product error:", err.message);
    res.status(500).json({ msg: err.message || "Delete failed" });
  }
});

module.exports = router;
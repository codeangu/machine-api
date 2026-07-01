const express = require("express");
const router  = express.Router();
const Product = require("../models/Product");
const auth    = require("../middleware/auth");

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
      if (body.unitPrice == null || body.initialStock == null) {
        return res.status(400).json({
          msg: "unitPrice and initialStock are required for single part."
        });
      }

      body.unitPrice    = Number(body.unitPrice);
      body.initialStock = Number(body.initialStock);
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
    const { search, admin } = req.query;

    // Admin: apne + baaki sab users ka data (role check)
    let userFilter = { user: req.user.id };
    if (admin === "true" && req.user.role === "admin") {
      userFilter = {};
    }

    let query = { ...userFilter };

    if (search) {
      query.$or = [
        { productName: { $regex: search, $options: "i" } },
        { model:       { $regex: search, $options: "i" } },
        { brand:       { $regex: search, $options: "i" } },
        { barcode:     search }
      ];
    }

    const products = await Product.find(query).sort({ createdAt: -1 });
    res.json(products);
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
        msg: "Ye product sale/purchase mein use ho chuka hai — delete nahi ho sakta."
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
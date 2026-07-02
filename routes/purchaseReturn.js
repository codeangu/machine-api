const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Purchase = require("../models/purchase");
const PurchaseReturn = require("../models/PurchaseReturn");
const Product = require("../models/Product");
const Supplier = require("../models/supplier");
const SupplierLedger = require("../models/SupplierLedger");
const auth = require("../middleware/auth");

async function withTxnRetry(fn, maxRetries = 4) {
  let attempt = 0;
  while (true) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const result = await fn(session);
      await session.commitTransaction();
      session.endSession();
      return result;
    } catch (err) {
      try { await session.abortTransaction(); } catch (e) {}
      session.endSession();
      const labels = err.errorLabels || [];
      const transient = labels.includes("TransientTransactionError") ||
                        labels.includes("UnknownTransactionCommitResult");
      const writeConflict = err.code === 112 || /write conflict/i.test(err.message || "");
      if ((transient || writeConflict) && attempt < maxRetries) {
        attempt++;
        await new Promise(r => setTimeout(r, 60 * attempt));
        continue;
      }
      throw err;
    }
  }
}

// ==========================================
// 1. CREATE PURCHASE RETURN
// Body: { purchaseId, items:[{ productId, quantity }], reason }
// Effect: stock -qty (must be in stock), supplier payable reduced
//         (ledger debit), supplier.totalPurchase reduced. Over-return prevented.
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { purchaseId, items, reason } = req.body;
    if (!purchaseId) throw new Error("Original purchase is required");
    if (!Array.isArray(items) || items.length === 0) throw new Error("Select at least one item to return");

    const returnId = await withTxnRetry(async (session) => {
      const purchase = await Purchase.findOne({ _id: purchaseId, user: req.user.id }).session(session);
      if (!purchase) throw new Error("Original purchase not found");

      // How much already returned per product on this purchase
      const priorReturns = await PurchaseReturn.find({ originalPurchase: purchaseId, user: req.user.id }).session(session);
      const alreadyReturned = {};
      priorReturns.forEach(r => r.items.forEach(it => {
        alreadyReturned[it.product.toString()] = (alreadyReturned[it.product.toString()] || 0) + it.quantity;
      }));

      const returnItems = [];
      let totalAmount = 0;

      for (const reqItem of items) {
        const qty = Number(reqItem.quantity) || 0;
        if (qty <= 0) continue;

        const purItem = purchase.items.find(pi => pi.product.toString() === String(reqItem.productId));
        if (!purItem) throw new Error("A returned item does not belong to this purchase");

        const purchasedQty = purItem.quantity;
        const priorQty = alreadyReturned[String(reqItem.productId)] || 0;
        if (qty + priorQty > purchasedQty) {
          throw new Error(`Return quantity exceeds purchased quantity. Purchased: ${purchasedQty}, already returned: ${priorQty}.`);
        }

        // Reduce stock — must have enough on hand (else it was already sold)
        const product = await Product.findOne({ _id: reqItem.productId, user: req.user.id }).session(session);
        if (!product) throw new Error("Product not found for return");
        if ((product.currentStock || 0) < qty) {
          throw new Error(`Not enough stock of "${product.productName}" to return. In stock: ${product.currentStock || 0}, trying to return: ${qty}.`);
        }
        product.currentStock -= qty;
        await product.save({ session });

        const lineTotal = qty * purItem.purchasePrice;
        totalAmount += lineTotal;

        returnItems.push({
          product: reqItem.productId,
          productName: reqItem.productName || product.productName,
          quantity: qty,
          purchasePrice: purItem.purchasePrice,
          lineTotal
        });
      }

      if (returnItems.length === 0) throw new Error("Select at least one item with quantity to return");

      const returnNumber = "PR-" + Math.floor(1000 + Math.random() * 9000);

      // Adjust supplier payable and capture the name for the return record
      const supplier = await Supplier.findOne({ _id: purchase.supplier, user: req.user.id }).session(session);

      const purchaseReturn = new PurchaseReturn({
        originalPurchase: purchase._id,
        purchaseNumber: purchase.purchaseNumber,
        returnNumber,
        supplier: purchase.supplier,
        supplierName: supplier ? supplier.name : "",
        items: returnItems,
        totalAmount,
        reason: reason || "",
        user: req.user.id
      });
      await purchaseReturn.save({ session });

      if (supplier) {
        supplier.totalPurchase -= totalAmount; // reduces what we owe
        await supplier.save({ session });

        const ledger = new SupplierLedger({
          supplier: purchase.supplier,
          transactionType: "Return",
          description: `Purchase Return ${returnNumber} (against Invoice #${purchase.purchaseNumber})`,
          credit: 0,
          debit: totalAmount, // debit reduces the supplier's running balance (payable)
          runningBalance: supplier.balance,
          referenceId: purchaseReturn._id,
          user: req.user.id
        });
        await ledger.save({ session });
      }

      return purchaseReturn._id;
    });

    res.status(201).json({ msg: "Purchase return recorded successfully", id: returnId });
  } catch (err) {
    console.error("Purchase Return Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  }
});

// ==========================================
// 2. LIST PURCHASE RETURNS (with date filter)
// ==========================================
router.get("/", auth, async (req, res) => {
  try {
    const { from, to } = req.query;
    const filter = { user: req.user.id };
    if (from || to) {
      filter.date = {};
      if (from) filter.date.$gte = new Date(from);
      if (to) { const d = new Date(to); d.setHours(23, 59, 59, 999); filter.date.$lte = d; }
    }
    const returns = await PurchaseReturn.find(filter)
      .populate("supplier", "name companyName phone")
      .sort({ date: -1 });
    res.json(returns);
  } catch (err) {
    res.status(500).json({ msg: "Failed to fetch purchase returns" });
  }
});

// ==========================================
// 3. GET RETURNS FOR A SPECIFIC PURCHASE
// ==========================================
router.get("/purchase/:purchaseId", auth, async (req, res) => {
  try {
    const returns = await PurchaseReturn.find({ originalPurchase: req.params.purchaseId, user: req.user.id });
    const returnedByProduct = {};
    returns.forEach(r => r.items.forEach(it => {
      returnedByProduct[it.product.toString()] = (returnedByProduct[it.product.toString()] || 0) + it.quantity;
    }));
    res.json({ returnedByProduct });
  } catch (err) {
    res.status(500).json({ msg: err.message });
  }
});

module.exports = router;

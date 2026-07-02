const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const Sale = require("../models/Sale");
const SaleReturn = require("../models/SaleReturn");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const CustomerLedger = require("../models/CustomerLedger");
const auth = require("../middleware/auth");

// Transaction helper with retry on transient Atlas write-conflicts
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
// 1. CREATE SALE RETURN
// Body: { saleId, items:[{ productId, quantity }], reason }
// Effect: stock +qty, customer receivable reduced (ledger credit),
//         customer.totalSale reduced. Over-return is prevented.
// ==========================================
router.post("/", auth, async (req, res) => {
  try {
    const { saleId, items, reason } = req.body;
    if (!saleId) throw new Error("Original sale is required");
    if (!Array.isArray(items) || items.length === 0) throw new Error("Select at least one item to return");

    const returnId = await withTxnRetry(async (session) => {
      const sale = await Sale.findOne({ _id: saleId, user: req.user.id }).session(session);
      if (!sale) throw new Error("Original sale not found");

      // How much has already been returned per product on this sale
      const priorReturns = await SaleReturn.find({ originalSale: saleId, user: req.user.id }).session(session);
      const alreadyReturned = {};
      priorReturns.forEach(r => r.items.forEach(it => {
        alreadyReturned[it.product.toString()] = (alreadyReturned[it.product.toString()] || 0) + it.quantity;
      }));

      const returnItems = [];
      let totalAmount = 0;

      for (const reqItem of items) {
        const qty = Number(reqItem.quantity) || 0;
        if (qty <= 0) continue; // skip zero-qty lines

        const saleItem = sale.items.find(si => si.product.toString() === String(reqItem.productId));
        if (!saleItem) throw new Error("A returned item does not belong to this sale");

        const soldQty = saleItem.quantity;
        const priorQty = alreadyReturned[String(reqItem.productId)] || 0;
        if (qty + priorQty > soldQty) {
          throw new Error(`Return quantity exceeds sold quantity. Sold: ${soldQty}, already returned: ${priorQty}.`);
        }

        const lineTotal = qty * saleItem.salePrice;
        totalAmount += lineTotal;

        // Restore stock
        const product = await Product.findOne({ _id: reqItem.productId, user: req.user.id }).session(session);
        if (product) {
          product.currentStock = (product.currentStock || 0) + qty;
          await product.save({ session });
        }

        returnItems.push({
          product: reqItem.productId,
          productName: reqItem.productName || (product ? product.productName : ""),
          quantity: qty,
          salePrice: saleItem.salePrice,
          lineTotal
        });
      }

      if (returnItems.length === 0) throw new Error("Select at least one item with quantity to return");

      const returnNumber = "SR-" + Math.floor(1000 + Math.random() * 9000);

      const saleReturn = new SaleReturn({
        originalSale: sale._id,
        invoiceNumber: sale.invoiceNumber,
        returnNumber,
        customer: sale.customer || null,
        customerName: sale.customerName || "Walking Customer",
        items: returnItems,
        totalAmount,
        reason: reason || "",
        user: req.user.id
      });
      await saleReturn.save({ session });

      // Adjust registered customer's receivable (walking customer has no ledger)
      if (sale.customer) {
        const customer = await Customer.findOne({ _id: sale.customer, user: req.user.id }).session(session);
        if (customer) {
          customer.totalSale -= totalAmount; // reduces balance (receivable)
          await customer.save({ session });

          const ledger = new CustomerLedger({
            customer: sale.customer,
            transactionType: "Return",
            description: `Sale Return ${returnNumber} (against Invoice #${sale.invoiceNumber})`,
            debit: 0,
            credit: totalAmount, // credit reduces the customer's running balance
            runningBalance: customer.balance,
            referenceId: saleReturn._id,
            user: req.user.id
          });
          await ledger.save({ session });
        }
      }

      return saleReturn._id;
    });

    res.status(201).json({ msg: "Sale return recorded successfully", id: returnId });
  } catch (err) {
    console.error("Sale Return Error:", err.message);
    res.status(500).json({ msg: err.message || "Server Error" });
  }
});

// ==========================================
// 2. LIST SALE RETURNS (with date filter)
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
    const returns = await SaleReturn.find(filter)
      .populate("customer", "name phone")
      .sort({ date: -1 });
    res.json(returns);
  } catch (err) {
    res.status(500).json({ msg: "Failed to fetch sale returns" });
  }
});

// ==========================================
// 3. GET RETURNS FOR A SPECIFIC SALE (remaining returnable qty)
// ==========================================
router.get("/sale/:saleId", auth, async (req, res) => {
  try {
    const returns = await SaleReturn.find({ originalSale: req.params.saleId, user: req.user.id });
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

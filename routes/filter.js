const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");

// 1. SARE MODELS YAHAN IMPORT KAREIN (Jo server.js mein hain)
const models = {
  supplier: require("../models/supplier"),
  purchase: require("../models/purchase"),
  product: require("../models/Product"),
  customer: require("../models/Customer"), // Ensure model file exists
  sale: require("../models/Sale"),         // Ensure model file exists
  ledger: require("../models/SupplierLedger"),
};

router.get("/:modelName", auth, async (req, res) => {
  try {
    const { modelName } = req.params;
    const Model = models[modelName.toLowerCase()];

    if (!Model) {
      return res.status(400).json({ msg: `Model '${modelName}' is not registered in the filter!` });
    }

    // 2. SECURITY: User ID hamesha filter mein rahegi
    let mongoQuery = { user: req.user.id };

    // 3. DYNAMIC QUERY GENERATOR
    Object.keys(req.query).forEach((key) => {
      const value = req.query[key];
      if (value && value !== "undefined" && value !== "null") {
        
        // Date Range Logic
        if (key === "startDate") {
          mongoQuery.date = { ...mongoQuery.date, $gte: new Date(value) };
        } else if (key === "endDate") {
          mongoQuery.date = { ...mongoQuery.date, $lte: new Date(value) };
        } 
        // Search Logic
        else if (key === "search") {
          mongoQuery.$or = [
            { name: { $regex: value, $options: "i" } },
            { purchaseNumber: { $regex: value, $options: "i" } },
            { invoiceNumber: { $regex: value, $options: "i" } }, // Sales ke liye
            { barcode: value }
          ];
        }
        // Baqi har cheez ke liye Generic Key match
        else {
          mongoQuery[key] = value;
        }
      }
    });

    // 4. DYNAMIC POPULATE (Har model ki zaroorat ke mutabiq)
    let execution = Model.find(mongoQuery).sort({ date: -1, createdAt: -1 });

    if (modelName === "purchase") {
      execution = execution.populate("supplier", "name companyName").populate("items.product", "name");
    } else if (modelName === "sale") {
      execution = execution.populate("customer", "name phone").populate("items.product", "name");
    } else if (modelName === "ledger") {
      execution = execution.populate("supplier", "name");
    }

    const results = await execution;
    res.json(results);

  } catch (err) {
    res.status(500).json({ msg: "Filter Error: " + err.message });
  }
});

module.exports = router;
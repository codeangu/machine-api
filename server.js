require("dotenv").config();
const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");
dns.setServers(["8.8.8.8", "8.8.4.4"]);
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const bodyParser = require("body-parser");

// Routes
const authRoutes = require("./routes/auth");
const supplierRoutes = require("./routes/supplier");
const productRoutes = require("./routes/product");

const app = express();

// ✅ Open CORS — allow requests from any origin
app.use(cors()); // ⚠️ Public access — frontend kahin se bhi request kar sakta

app.use(bodyParser.json());

// Test Route
app.get("/api/status", (req, res) => {
  res.json({ status: "true" });
});

// Main Routes
app.use("/api/auth", authRoutes);

app.use("/api/supplier", require("./routes/supplier"));
app.use("/api/purchase", require("./routes/purchase"));
app.use("/api/product", productRoutes);
app.use("/api/products", productRoutes); 
app.use("/api/customer", require("./routes/customer")); 
app.use("/api/sale", require("./routes/sale"));
app.use("/api/sale-return", require("./routes/saleReturn"));
app.use("/api/purchase-return", require("./routes/purchaseReturn"));
app.use("/api/filter", require("./routes/filter"));
app.use("/api/reports", require("./routes/reports"));
// MongoDB Connection
// MongoDB Connection (cached for serverless)
let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  try {
    await mongoose.connect(process.env.MONGO_URI, {
      bufferCommands: false,
      serverSelectionTimeoutMS: 10000,
    });
    isConnected = true;
    console.log("✅ MongoDB Connected...!");
  } catch (err) {
    console.log("❌ MongoDB Error:", err);
  }
}

connectDB();

app.use(async (req, res, next) => {
  if (!isConnected) {
    await connectDB();
  }
  next();
});

// Local server
if (require.main === module) {
  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => {
    console.log(`🚀 Server running locally at http://localhost:${PORT}`);
  });
}

// For Vercel
module.exports = app;
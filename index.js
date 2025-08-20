// index.js
require('dotenv').config();
const express = require('express');
const Pusher = require('pusher');
const { PriceServiceConnection } = require("@pythnetwork/price-service-client");

// Define your price IDs (Replace with actual IDs)
const priceIds = ["0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744", "0x6120ffcf96395c70aa77e72dcb900bf9d40dccab228efca59a17b90ce423d5e8", "0xeba0732395fae9dec4bae12e52760b35fc1c5671e2da8b449c9af4efe5d54341"];

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Pusher with environment variables
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,      // Ensure this is correct
  key: process.env.PUSHER_KEY,           // Ensure this is correct
  secret: process.env.PUSHER_SECRET,     // Ensure this is correct
  cluster: process.env.PUSHER_CLUSTER,   // Ensure this matches your Pusher app's cluster
  useTLS: true,
});

// Initialize PriceServiceConnection
let connection = null;

// Variables to manage latest price feed and reconnection
//let latestPriceFeed = null;
let unsubscribe = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const INITIAL_RECONNECT_DELAY = 1000; // 1 second
const MAX_RECONNECT_DELAY = 30000;    // 30 seconds

let latestPriceFeedsMap = {};

// Function to initialize the PriceServiceConnection
const initializeConnection = () => {
  connection = new PriceServiceConnection("https://hermes.pyth.network");

  // Attempt to subscribe to price updates
  subscribeToPriceUpdates();
};

// Function to attempt reconnection with exponential backoff
const attemptReconnection = () => {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('Max reconnection attempts reached. Giving up.');
    return;
  }

  const delay = Math.min(INITIAL_RECONNECT_DELAY * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY);
  console.log(`Attempting to reconnect in ${delay / 1000} seconds...`);

  setTimeout(() => {
    reconnectAttempts += 1;
    console.log(`Reconnection attempt #${reconnectAttempts}`);
    initializeConnection();
  }, delay);
};

// Function to fetch latest price feeds
const fetchLatestPriceFeeds = async () => {
  try {
    const priceFeeds = await connection.getLatestPriceFeeds(priceIds);
    console.log('Fetched latest price feeds:', priceFeeds);
    // Broadcast initial prices to Pusher
    await pusher.trigger('price-feed-channel', 'price-feeds-update', {
      message: { priceFeeds: priceFeeds },
    });
    console.log('Initial prices broadcasted.');
  } catch (error) {
    console.error('Error fetching latest price feeds:', error);
  }
};

// Function to subscribe to price feed updates
const subscribeToPriceUpdates = () => {
  try {
    unsubscribe = connection.subscribePriceFeedUpdates(priceIds, (priceFeed) => {
      try {


        // Use getPriceNoOlderThan if it exists, else fallback to priceFeed.price
        const price = typeof priceFeed.getPriceNoOlderThan === 'function'
            ? priceFeed.getPriceNoOlderThan(60)
            : priceFeed.price;

        //console.log(`Received an update for ${priceFeed.id}: ${price}`);

        latestPriceFeedsMap[priceFeed.id] = {
          id: priceFeed.id,
          price: price,
          timestamp: new Date(priceFeed.timestamp || Date.now()),
        };

        // // Store the latest price update
        // latestPriceFeed = {
        //   id: priceFeed.id,
        //   price: price,
        //   timestamp: new Date(priceFeed.timestamp || Date.now()), // Adjust if timestamp is available
        // };
      } catch (error) {
        console.error(`Error processing price update for ${priceFeed.id}:`, error);
      }
    });

    console.log('Subscribed to price feed updates.');
  } catch (error) {
    console.error('Error subscribing to price feed updates:', error);
    attemptReconnection();
  }
};

// Function to periodically send updates to Pusher every 10 seconds
const setupPeriodicPusherUpdates = () => {
  setInterval(async () => {
    const allFeeds = Object.values(latestPriceFeedsMap);
    if (allFeeds.length > 0) {
      console.log("allFeeds")
      console.log(allFeeds)
      await pusher.trigger("price-feed-channel", "price-update", {
        feeds: allFeeds,
      });
      // Optionally reset or keep them
      // latestPriceFeedsMap = {};
    } else {
      console.log("No new price updates to broadcast at this time.");
    }
  }, 5000);
};

// Graceful shutdown handler
const gracefulShutdown = () => {
  return () => {
    console.log('Shutting down gracefully...');
    if (unsubscribe && typeof unsubscribe === 'function') {
      unsubscribe();
      console.log('Unsubscribed from price updates.');
    } else {
      console.warn('No unsubscribe function available.');
    }
    if (connection) {
      connection.closeWebSocket();
      console.log('WebSocket connection closed.');
    }
    process.exit(0);
  };
};

// Define a simple route
app.get('/', (req, res) => {
  res.send('Price Feed Backend is running.');
});

// Start the server
app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  // Initialize the connection
  initializeConnection();

  // Fetch and broadcast initial price feeds
  await fetchLatestPriceFeeds();

  // Set up periodic Pusher updates every 10 seconds
  setupPeriodicPusherUpdates();

  // Handle termination signals for graceful shutdown
  process.on('SIGINT', gracefulShutdown());
  process.on('SIGTERM', gracefulShutdown());
});

// Global handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Optionally exit the process or perform cleanup
  // process.exit(1);
});

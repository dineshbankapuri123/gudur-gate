require("dotenv").config();

const axios = require("axios");
const admin = require("firebase-admin");
const { getDatabase } = require("firebase-admin/database");
const { cert } = require("firebase-admin/app");

// ============================================================
// FIREBASE CONFIGURATION
// ============================================================

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing.");
  process.exit(1);
}

let serviceAccount;

try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch (error) {
  console.error("❌ FIREBASE_SERVICE_ACCOUNT contains invalid JSON.");
  console.error(error.message);
  process.exit(1);
}

admin.initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://gudur-gate-tracker-default-rtdb.firebaseio.com"
});

const db = getDatabase();
const gateRef = db.ref("gudur_gates");

// ============================================================
// RAILRADAR CONFIGURATION
// ============================================================

const RAILRADAR_API_KEY = String(
  process.env.RAILRADAR_API_KEY || ""
)
  .trim()
  .replace(/['"]+/g, "");

const RAILRADAR_BASE_URL = "https://api.railradar.in/v1";

if (!RAILRADAR_API_KEY) {
  console.warn("⚠️ RAILRADAR_API_KEY environment variable is missing.");
}

// ============================================================
// TIRUPATI CORRIDOR TRAINS
// ============================================================

const TIRUPATI_CORRIDOR_TRAINS = new Set([
  "12733",
  "12734",
  "17487",
  "17488",
  "12763",
  "12764",
  "17261",
  "17262",
  "17479",
  "17480",
  "07669",
  "07670"
]);

// ============================================================
// NORTH-BOUND TRAIN DETECTION
// ============================================================

function isNorthBound(trainName, destination) {
  const dest = String(destination || "").toUpperCase();

  return (
    dest.includes("VIJAYAWADA") ||
    dest.includes("BZA") ||
    dest.includes("NELLORE") ||
    dest.includes("NLR") ||
    dest.includes("HOWRAH") ||
    dest.includes("HWH")
  );
}

// ============================================================
// TIME PARSER
// ============================================================

function parseTimeToMinutes(timeStr, delayMinutes = 0) {
  if (!timeStr) {
    return -1;
  }

  let totalMinutes = -1;

  const date = new Date(timeStr);

  if (!isNaN(date.getTime())) {
    totalMinutes =
      date.getHours() * 60 +
      date.getMinutes();
  } else {
    const match = String(timeStr)
      .trim()
      .match(/(\d{1,2}):(\d{2})/);

    if (match) {
      totalMinutes =
        parseInt(match[1], 10) * 60 +
        parseInt(match[2], 10);
    }
  }

  if (totalMinutes === -1) {
    return -1;
  }

  return totalMinutes + Number(delayMinutes || 0);
}

// ============================================================
// UPDATE GATE SYSTEM
// ============================================================

async function updateGateSystem() {
  try {
    const now = new Date();

    const currentMin =
      now.getHours() * 60 +
      now.getMinutes();

    console.log(
      `\n[${now.toLocaleTimeString()}] Querying RailRadar Live Station Board for GDR...`
    );

    // ----------------------------------------------------------
    // RAILRADAR REQUEST
    // ----------------------------------------------------------

    const boardRes = await axios.get(
      `${RAILRADAR_BASE_URL}/stations/GDR/live?hours=4`,
      {
        headers: {
          Authorization: `Bearer ${RAILRADAR_API_KEY}`
        },
        timeout: 12000
      }
    );

    const responseBody = boardRes.data;

    const trainsArray =
      responseBody?.data?.trains || [];

    if (!Array.isArray(trainsArray)) {
      console.error(
        "❌ RailRadar returned invalid train data."
      );
      return;
    }

    // ----------------------------------------------------------
    // DEFAULT GATE STATUS
    // ----------------------------------------------------------

    const upcomingList = [];

    let masGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear"
    };

    let tptyGate = {
      status: "OPEN",
      waitMinutes: 0,
      activeTrain: "Tracks clear"
    };

    // ----------------------------------------------------------
    // PROCESS EACH TRAIN
    // ----------------------------------------------------------

    for (const item of trainsArray) {
      const train = item.train || {};
      const live = item.live || {};
      const stop = item.stop || {};

      const trainNo = String(
        train.number || ""
      ).trim();

      const trainName =
        train.name ||
        `Express ${trainNo}`;

      const destination =
        train.destination ||
        train.to ||
        item.destination ||
        "";

      const delayMin = Number(
        live.delayMinutes || 0
      );

      // --------------------------------------------------------
      // ARRIVAL AND DEPARTURE
      // --------------------------------------------------------

      const arrTimeStr =
        stop.arrival ||
        live.expectedArrivalTime ||
        "";

      const depTimeStr =
        stop.departure ||
        live.expectedDepartureTime ||
        arrTimeStr;

      const arrMin =
        parseTimeToMinutes(
          arrTimeStr,
          delayMin
        );

      const depMin =
        parseTimeToMinutes(
          depTimeStr,
          delayMin
        );

      if (arrMin === -1) {
        continue;
      }

      // --------------------------------------------------------
      // CALCULATE TIME DIFFERENCE
      // --------------------------------------------------------

      let diff = arrMin - currentMin;

      if (diff < -720) {
        diff += 1440;
      }

      if (diff > 720) {
        diff -= 1440;
      }

      // Ignore trains that passed more than 15 minutes ago
      // or trains more than 45 minutes away.

      if (diff < -15 || diff > 45) {
        continue;
      }

      // --------------------------------------------------------
      // DETERMINE CORRIDOR
      // --------------------------------------------------------

      let corridor = "MAS";

      if (
        TIRUPATI_CORRIDOR_TRAINS.has(trainNo)
      ) {
        corridor = "TPTY";
      } else if (
        isNorthBound(
          trainName,
          destination
        )
      ) {
        corridor = "BZA";
      }

      // --------------------------------------------------------
      // ADD TRAIN TO UPCOMING LIST
      // --------------------------------------------------------

      upcomingList.push({
        trainNo: trainNo,
        name: trainName,
        etaMinutes: Math.max(0, diff),
        delayMinutes: delayMin,
        corridor: corridor,
        platform: String(
          live.platform || "1"
        )
      });

      // --------------------------------------------------------
      // GATE CLOSURE CONDITIONS
      // --------------------------------------------------------

      const isApproaching =
        diff >= 0 &&
        diff <= 4;

      const isAtStation =
        currentMin >= arrMin &&
        currentMin <=
          (
            depMin !== -1
              ? depMin
              : arrMin + 5
          );

      if (
        isApproaching ||
        isAtStation
      ) {
        let waitTime;

        if (
          isAtStation &&
          depMin !== -1
        ) {
          waitTime = Math.max(
            1,
            depMin - currentMin
          );
        } else if (isAtStation) {
          waitTime = 5;
        } else {
          waitTime = Math.max(
            1,
            diff + 2
          );
        }

        const trainStatus =
          isAtStation
            ? "At Station"
            : delayMin > 0
              ? `${delayMin}m late`
              : "On Time";

        const label =
          `${trainNo} ${trainName} (${trainStatus})`;

        const payload = {
          status: "CLOSED",
          waitMinutes: waitTime,
          activeTrain: label
        };

        // ------------------------------------------------------
        // UPDATE CORRESPONDING GATE
        // ------------------------------------------------------

        if (corridor === "TPTY") {
          tptyGate = payload;
        } else if (corridor === "MAS") {
          masGate = payload;
        }
      }
    }

    // ----------------------------------------------------------
    // SORT TRAINS
    // ----------------------------------------------------------

    upcomingList.sort(
      (a, b) =>
        a.etaMinutes -
        b.etaMinutes
    );

    const topUpcoming =
      upcomingList.slice(0, 5);

    // ----------------------------------------------------------
    // UPDATE FIREBASE
    // ----------------------------------------------------------

    await gateRef.set({
      tirupatiGate: tptyGate,
      chennaiGate: masGate,
      upcomingTrains: topUpcoming,
      lastUpdated:
        now.toLocaleTimeString()
    });

    // ----------------------------------------------------------
    // SUCCESS LOGS
    // ----------------------------------------------------------

    console.log(
      "[SYNC SUCCESS] Firebase updated."
    );

    console.log(
      ` -> Chennai Gate : ${masGate.status} (${masGate.activeTrain})`
    );

    console.log(
      ` -> Tirupati Gate: ${tptyGate.status} (${tptyGate.activeTrain})`
    );

    console.log(
      ` -> Upcoming trains: ${topUpcoming.length}`
    );

  } catch (err) {
    if (err.response) {
      console.error(
        `[ERROR] RailRadar fetch failed: HTTP ${err.response.status}`
      );

      console.error(
        "Response:",
        err.response.data
      );
    } else {
      console.error(
        `[ERROR] ${err.message}`
      );
    }
  }
}

// ============================================================
// START APPLICATION
// ============================================================

console.log(
  "=========================================="
);

console.log(
  " RailRadar Real-time Gate Monitor Active "
);

console.log(
  " Chennai Gate:  14.13968 N, 79.84419 E   "
);

console.log(
  " Tirupati Gate: 14.14024 N, 79.84361 E   "
);

console.log(
  "=========================================="
);

// Run immediately
updateGateSystem();

// Run every 3 minutes
setInterval(
  updateGateSystem,
  180000
);

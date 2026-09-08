const express = require('express');
const axios = require('axios');
const path = require('path');
const admin = require('firebase-admin');

// 1. Initialize Firebase Admin SDK (Shares your existing Firestore database)
admin.initializeApp({
  projectId: process.env.GOOGLE_CLOUD_PROJECT || '65744691245',
});

// Use the Firestore instance from Firebase Admin
const db = admin.firestore();

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 8080;
const REBRICKABLE_API_KEY = process.env.REBRICKABLE_API_KEY;

/**
 * Endpoint to serve Firebase web config dynamically to the frontend
 */
app.get('/api/config/firebase', (req, res) => {
  res.json({
    apiKey: process.env.FIREBASE_WEB_API_KEY || '',
    authDomain: `${process.env.GOOGLE_CLOUD_PROJECT || '65744691245'}.firebaseapp.com`,
    projectId: process.env.GOOGLE_CLOUD_PROJECT || '65744691245',
  });
});

/**
 * Authentication Middleware
 * Verifies the Google ID Token sent from index.html
 */
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or malformed token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Contains req.user.uid and req.user.email
    next();
  } catch (error) {
    console.error('Token verification error:', error.message);
    return res.status(403).json({ error: 'Unauthorized: Invalid token' });
  }
};

/**
 * GET /
 * Serves the primary web interface
 */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/**
 * GET /api/sets
 * Retrieves all sets belonging to the logged-in user
 */
app.get('/api/sets', authenticateUser, async (req, res) => {
  try {
    const snapshot = await db
      .collection('sets')
      .where('userId', '==', req.user.uid)
      .get();

    const sets = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
    return res.status(200).json(sets);
  } catch (error) {
    console.error('Error fetching user sets:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/**
 * GET /api/sets/:setNum/missing-parts/pick-a-brick
 * Retrieves missing parts scoped to the authenticated user
 */
app.get('/api/sets/:setNum/missing-parts/pick-a-brick', authenticateUser, async (req, res) => {
  try {
    const { setNum } = req.params;
    const { format = 'json' } = req.query;

    // 1. Fetch missing parts tracked under this set document in Firestore
    const snapshot = await db
      .collection('sets')
      .doc(setNum)
      .collection('missing_parts')
      .where('quantity', '>', 0)
      .get();

    if (snapshot.empty) {
      return res.status(200).json({ message: 'No missing parts found for this set.', items: [] });
    }

    const missingParts = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

    // 2. Resolve missing Element IDs via Rebrickable API
    const formattedItems = await Promise.all(
      missingParts.map(async (item) => {
        let elementId = item.element_id;

        if (!elementId && item.part_num && item.color_id) {
          try {
            const rbRes = await axios.get(
              `https://rebrickable.com/api/v3/lego/sets/${setNum}/parts/`,
              {
                headers: { Authorization: `key ${REBRICKABLE_API_KEY}` },
                params: { page_size: 1000 },
              }
            );

            const match = rbRes.data.results.find(
              (p) => p.part.part_num === item.part_num && p.color.id === item.color_id
            );

            if (match && match.element_id) {
              elementId = match.element_id;
            }
          } catch (err) {
            console.warn(`Failed to fetch element_id for ${item.part_num}:`, err.message);
          }
        }

        return {
          elementId: elementId || 'UNKNOWN',
          quantity: item.quantity,
          partNum: item.part_num || null,
        };
      })
    );

    const validItems = formattedItems.filter((i) => i.elementId !== 'UNKNOWN');

    // 3. Output as Pick a Brick CSV or JSON
    if (format.toLowerCase() === 'csv') {
      let csvContent = 'Element ID,Quantity\n';
      validItems.forEach((item) => {
        csvContent += `${item.elementId},${item.quantity}\n`;
      });

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${setNum}-missing-parts.csv"`);
      return res.status(200).send(csvContent);
    }

    return res.status(200).json({
      set_num: setNum,
      total_missing_elements: validItems.length,
      pick_a_brick_payload: validItems.map((item) => ({
        element_id: item.elementId,
        quantity: item.quantity,
      })),
      unresolved_items: formattedItems.filter((i) => i.elementId === 'UNKNOWN'),
    });
  } catch (error) {
    console.error('Error fetching missing parts:', error);
    return res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

/**
 * POST /api/admin/claim-legacy-data
 * ONE-TIME MIGRATION: Claims all existing root-level sets for your logged-in Google UID
 */
app.post('/api/admin/claim-legacy-data', authenticateUser, async (req, res) => {
  try {
    const userUid = req.user.uid;
    const setsRef = db.collection('sets');
    const snapshot = await setsRef.get();

    if (snapshot.empty) {
      return res.status(200).json({ message: 'No legacy sets found to claim.' });
    }

    const batch = db.batch();
    let claimedCount = 0;

    snapshot.docs.forEach((doc) => {
      const data = doc.data();
      if (!data.userId) {
        batch.update(doc.ref, { userId: userUid });
        claimedCount++;
      }
    });

    if (claimedCount > 0) {
      await batch.commit();
    }

    return res.status(200).json({
      message: `Successfully assigned ${claimedCount} legacy set(s) to user ID: ${userUid}`,
    });
  } catch (error) {
    console.error('Error claiming legacy data:', error);
    return res.status(500).json({ error: 'Failed to claim data', details: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`LEGO Tracker running on port ${PORT}`);
});
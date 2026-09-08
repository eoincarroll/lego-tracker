const express = require('express');
const axios = require('axios');
const { Firestore } = require('@google-cloud/firestore');

const app = express();
app.use(express.json());

const db = new Firestore();
const PORT = process.env.PORT || 8080;
const REBRICKABLE_API_KEY = process.env.REBRICKABLE_API_KEY;

// Health Check Endpoint
app.get('/', (req, res) => {
  res.send('LEGO Tracker Service is active.');
});

/**
 * GET /api/sets/:setNum/missing-parts/pick-a-brick
 * Query params: format = 'json' | 'csv'
 */
app.get('/api/sets/:setNum/missing-parts/pick-a-brick', async (req, res) => {
  try {
    const { setNum } = req.params;
    const { format = 'json' } = req.query;

    // 1. Fetch missing parts tracked in Firestore
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

app.listen(PORT, () => {
  console.log(`LEGO Tracker running on port ${PORT}`);
});
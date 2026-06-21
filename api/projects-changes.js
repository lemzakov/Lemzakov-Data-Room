// Stub for Google Drive `changes.watch` push notifications (future work).
//
// Drive can POST a notification here whenever a watched folder changes, enabling
// near-instant sync instead of waiting for the cron. Fully implementing it
// requires registering a watch channel per project (drive.changes.watch),
// persisting channel/resource IDs, mapping the changed file back to its project,
// and renewing channels before they expire. Until then this endpoint simply
// acknowledges the notification (Drive requires a 2xx) and logs it; the cron
// keeps projects in sync in the meantime.

module.exports = async function handler(req, res) {
  // Drive sends metadata in headers (X-Goog-Resource-State, X-Goog-Channel-Id…).
  const state = req.headers['x-goog-resource-state'] || '';
  const channelId = req.headers['x-goog-channel-id'] || '';
  console.log('[projects-changes] notification received (not yet acted on)', {
    state, channelId
  });

  // Always 2xx so Drive does not retry/disable the channel.
  res.statusCode = 200;
  res.setHeader('Cache-Control', 'no-store');
  return res.end('ok');
};

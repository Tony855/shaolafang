const fs = require('fs');

// Remove extracted files that no successfully imported menu row references.
// The caller owns both sets and may invoke this after normal completion or abort.
function cleanupUnreferencedImages(createdImagePaths, retainedImagePaths, unlinkSync = fs.unlinkSync) {
  for (const imagePath of createdImagePaths) {
    if (retainedImagePaths.has(imagePath)) continue;
    try { unlinkSync(imagePath); } catch (_) { /* best-effort cleanup; never mask import result */ }
  }
}

module.exports = { cleanupUnreferencedImages };

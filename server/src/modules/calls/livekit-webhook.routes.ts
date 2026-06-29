/**
 * LiveKit webhook receiver — handles `egress_ended` to kick off the meeting-notes
 * pipeline (transcribe → summarize → email).
 *
 * Mounted WITHOUT the user auth middleware: LiveKit authenticates the webhook
 * itself with a JWT in the Authorization header, signed with our API secret.
 * `WebhookReceiver` validates that signature against the raw request body, so we
 * mount this route with a raw body parser.
 */
import { Router } from 'express';
import express from 'express';
import { WebhookReceiver } from 'livekit-server-sdk';
import { processMeetingRecording } from '../ai/meeting-notes.service';

const router = Router();
const receiver = new WebhookReceiver(
  process.env.LIVEKIT_API_KEY || '',
  process.env.LIVEKIT_API_SECRET || '',
);

router.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  try {
    const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');
    const event = await receiver.receive(body, req.get('Authorization'));

    if (event.event === 'egress_ended') {
      const eg: any = event.egressInfo;
      const egressId: string | undefined = eg?.egressId;
      // v2 egress reports outputs under fileResults (preferred) or legacy file.
      const filename: string | undefined =
        eg?.fileResults?.[0]?.filename || eg?.file?.filename || eg?.fileResults?.[0]?.location;
      if (egressId) {
        // Fire-and-forget — the pipeline records its own state/errors.
        processMeetingRecording(egressId, filename).catch((e) =>
          console.error('[LiveKit webhook] pipeline error:', e.message),
        );
      }
    }
    res.status(200).send('ok');
  } catch (err: any) {
    // Always 200 so LiveKit doesn't retry-storm us on a parse/validation hiccup.
    console.error('[LiveKit webhook] error:', err.message);
    res.status(200).send('ok');
  }
});

export default router;

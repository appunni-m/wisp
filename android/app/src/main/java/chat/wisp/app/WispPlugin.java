package chat.wisp.app;

import android.app.Activity;
import android.content.Intent;
import android.nfc.NdefMessage;
import android.nfc.NdefRecord;
import android.nfc.NfcAdapter;
import android.nfc.Tag;
import android.nfc.tech.Ndef;
import android.nfc.tech.NdefFormatable;
import android.os.Build;
import android.os.Bundle;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * The two things the web layer cannot do inside a WebView:
 *
 *   1. Keep a connection alive in the background (foreground service).
 *   2. Read and write NFC tags. Web NFC is a Chrome-*browser* API and is simply
 *      absent in a WebView, so tags need the platform API.
 *
 * Invite links are also delivered from here: a `linkline://pair` or https intent
 * carries the invite code in its fragment, and the web layer verifies the
 * signature on arrival exactly as it does for a pasted code. Nothing about the
 * intent is trusted.
 */
@CapacitorPlugin(name = "Wisp")
public class WispPlugin extends Plugin implements NfcAdapter.ReaderCallback {

    private NfcAdapter adapter;
    private PluginCall pendingWrite;
    private boolean scanning = false;

    @Override
    public void load() {
        adapter = NfcAdapter.getDefaultAdapter(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        JSObject result = new JSObject();
        boolean hasNfc = adapter != null;
        result.put("nfc", hasNfc);
        result.put("nfcEnabled", hasNfc && adapter.isEnabled());
        result.put("keepAlive", true);
        result.put("background", true);
        call.resolve(result);
    }

    /** Start or stop the foreground service that holds the connection open. */
    @PluginMethod
    public void keepAlive(PluginCall call) {
        boolean enabled = !Boolean.FALSE.equals(call.getBoolean("enabled", Boolean.TRUE));
        String text = call.getString("text", "Keeping your direct connection open");

        Intent intent = new Intent(getContext(), ConnectionService.class);
        intent.putExtra("text", text);
        if (enabled) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } else {
            getContext().stopService(intent);
        }
        call.resolve();
    }

    /* ------------------------------------------------------------------ NFC */

    @PluginMethod
    public void nfcWrite(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url is required");
            return;
        }
        String problem = nfcProblem();
        if (problem != null) {
            call.reject(problem);
            return;
        }
        pendingWrite = call;
        call.setKeepAlive(true);
        enableReaderMode();
    }

    @PluginMethod
    public void nfcScan(PluginCall call) {
        String problem = nfcProblem();
        if (problem != null) {
            call.reject(problem);
            return;
        }
        scanning = true;
        enableReaderMode();
        call.resolve();
    }

    @PluginMethod
    public void nfcStop(PluginCall call) {
        scanning = false;
        disableReaderMode();
        call.resolve();
    }

    private String nfcProblem() {
        if (adapter == null) return "This device has no NFC reader.";
        if (!adapter.isEnabled()) return "NFC is switched off. Turn it on in Settings, then try again.";
        return null;
    }

    @Override
    public void onTagDiscovered(Tag tag) {
        if (pendingWrite != null) {
            PluginCall call = pendingWrite;
            pendingWrite = null;
            disableReaderMode();
            try {
                writeUrl(tag, call.getString("url"));
                call.resolve();
            } catch (TagTooSmallException error) {
                call.reject("TAG_TOO_SMALL:" + error.capacity);
            } catch (Exception error) {
                call.reject(error.getMessage() == null ? "Could not write to that tag." : error.getMessage());
            }
            return;
        }

        if (!scanning) return;
        JSObject data = new JSObject();
        data.put("url", readUrl(tag));
        notifyListeners("nfcTag", data, true);
    }

    private static class TagTooSmallException extends Exception {
        final int capacity;
        TagTooSmallException(int capacity) {
            this.capacity = capacity;
        }
    }

    private void writeUrl(Tag tag, String url) throws Exception {
        NdefMessage message = new NdefMessage(new NdefRecord[] { NdefRecord.createUri(url) });

        Ndef ndef = Ndef.get(tag);
        if (ndef != null) {
            ndef.connect();
            try {
                if (!ndef.isWritable()) throw new Exception("That tag is read-only.");
                int size = message.toByteArray().length;
                if (ndef.getMaxSize() < size) throw new TagTooSmallException(ndef.getMaxSize());
                ndef.writeNdefMessage(message);
            } finally {
                try {
                    ndef.close();
                } catch (Exception ignored) {
                    // closing a tag that was already pulled away is not interesting
                }
            }
            return;
        }

        NdefFormatable formatable = NdefFormatable.get(tag);
        if (formatable != null) {
            formatable.connect();
            try {
                formatable.format(message);
            } finally {
                try {
                    formatable.close();
                } catch (Exception ignored) {
                    // as above
                }
            }
            return;
        }

        throw new Exception("That tag cannot hold NDEF data.");
    }

    private String readUrl(Tag tag) {
        Ndef ndef = Ndef.get(tag);
        if (ndef == null) return null;
        try {
            ndef.connect();
            NdefMessage message = ndef.getNdefMessage();
            if (message == null) return null;
            for (NdefRecord record : message.getRecords()) {
                if (record.getTnf() == NdefRecord.TNF_WELL_KNOWN
                        && java.util.Arrays.equals(record.getType(), NdefRecord.RTD_URI)) {
                    android.net.Uri uri = record.toUri();
                    if (uri != null) return uri.toString();
                }
            }
        } catch (Exception ignored) {
            return null;
        } finally {
            try {
                ndef.close();
            } catch (Exception ignored) {
                // as above
            }
        }
        return null;
    }

    private void enableReaderMode() {
        Activity activity = getActivity();
        if (activity == null || adapter == null) return;
        int flags = NfcAdapter.FLAG_READER_NFC_A
                | NfcAdapter.FLAG_READER_NFC_B
                | NfcAdapter.FLAG_READER_NFC_F
                | NfcAdapter.FLAG_READER_NFC_V
                | NfcAdapter.FLAG_READER_NO_PLATFORM_SOUNDS;
        adapter.enableReaderMode(activity, this, flags, new Bundle());
    }

    private void disableReaderMode() {
        Activity activity = getActivity();
        if (activity == null || adapter == null) return;
        try {
            adapter.disableReaderMode(activity);
        } catch (Exception ignored) {
            // the activity may already be gone
        }
    }

    /* ---------------------------------------------------------- invite links */

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        if (intent != null && intent.getData() != null) {
            JSObject data = new JSObject();
            data.put("url", intent.getData().toString());
            notifyListeners("appUrl", data, true);
        }
    }

    /** The URL that launched the app, if it was launched from an invite link. */
    @PluginMethod
    public void getLaunchUrl(PluginCall call) {
        Activity activity = getActivity();
        Intent intent = activity != null ? activity.getIntent() : null;
        JSObject result = new JSObject();
        if (intent != null && intent.getData() != null) {
            result.put("url", intent.getData().toString());
        }
        call.resolve(result);
    }

    @Override
    protected void handleOnDestroy() {
        disableReaderMode();
        super.handleOnDestroy();
    }
}

import * as BunnySDK from "@bunny.net/edgescript-sdk";

/**
 * Bunny.net Standalone Edge Server Handler
 * Intercepts client sign-off payloads, secures tokens, and dispatches delivery notifications.
 */
BunnySDK.net.http.serve(async (request) => {
    if (request.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    try {
        const payload = await request.json();
        
        // Securely map private email gateway keys here out of client view
        payload.secret_routing_token = "YOUR_HIDDEN_PRODUCTION_TOKEN_HERE";
        
        const targetGateway = "[https://api.web3forms.com/submit](https://api.web3forms.com/submit)"; // Or EmailJS target endpoint
        const emailResponse = await fetch(targetGateway, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (emailResponse.ok) {
            return new Response(JSON.stringify({ success: true }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        return new Response(JSON.stringify({ success: false }), { status: 502 });
        
    } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
});
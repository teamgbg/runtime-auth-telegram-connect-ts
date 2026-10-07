/**
 * @system runtime-auth-flow
 * @status handwritten
 */
/**
 * The multi-step phone login as JSON, for a UI service to drive.
 *
 * This is the piece that keeps telegram-forms.ts alive. Unlike WhatsApp — whose
 * page only DISPLAYED a QR — Telegram's phone path is genuinely interactive:
 * handleTelegramPhoneStep and friends RETURN a rendered form as their response
 * on every branch, so the HTML file is a working login flow rather than dead
 * display code. Deleting it before a portal replacement exists would remove
 * functionality, not drift.
 *
 * So each step returns the flow STATE instead of markup, and the portal decides
 * what to render:
 *   next: "code"      → we sent a login code; ask for it
 *   next: "password"  → 2FA is on; ask for the account password
 *   next: "done"      → authenticated; the caller redirects
 *   next: "phone"     → start over (or retry) with `error` explaining why
 *
 * `accountId` is threaded through by the caller because a Telegram connection is
 * a per-attempt TDLib client; it is the key every subsequent step and the status
 * poll share.
 */

/**
 * Turn a step state into the caller's preferred response.
 *
 * With `returnTo` the browser drives the flow by ordinary form POST + redirect:
 * the portal renders one page per step (`region-views-are-pages` — a step is a
 * URL, not component state), so no client-side state machine and no bespoke
 * block are needed, and the whole login composes from FormField + Button.
 * Without it the state is returned as JSON for a programmatic caller.
 *
 * The redirect carries `error` so the next page can show why a step failed, and
 * `done` goes to the caller's success URL rather than another step.
 */

/**
 * GET /telegram/connect/qr.png — the QR as IMAGE BYTES, for an <img> tag.
 *
 * Same reasoning as whatsappConnectQrImage: a connect QR is per-user and
 * single-use, and the SSR loader graph is cached on a key with no user in it, so
 * the QR must never be resolved into page-data. Serving bytes moves auth to
 * image-fetch time, where the .scala.business session cookie is present.
 *
 * TELEGRAM'S EXTRA CONSTRAINT, and why a cookie. Telegram mints a NEW TDLib
 * client per connection attempt (`orgId:connectionId`) so a second number
 * connects rather than replacing the org's existing one — and that same id is
 * the key the status poll uses. The page cannot mint it: the resolver that would
 * do so runs in the cached graph, so every visitor would share one connection.
 * So the id is minted HERE, per image request, and returned to the browser as a
 * gateway-scoped HttpOnly cookie; the status poll reads it back. The page stays
 * completely static and never learns the id, which is what keeps it out of the
 * cache.
 */

/**
 * GET /telegram/connect/data — the QR step as JSON, for a UI service to render.
 *
 * Deliberately the SAME `{status, qrDataUri, error}` shape as
 * `whatsappConnectData`, so one portal page shape, one resolver shape and one
 * Image binding serve both providers. The two differ only in where the pixels
 * come from: GOWA hands back a QR IMAGE, while Telegram hands back a
 * `tg://login?token=…` STRING that the renderer must turn into a QR itself —
 * which is what `QRCode.toString` does here (the gateway already did exactly
 * this inside its hand-rolled page, so no new capability is introduced, only a
 * format that is not HTML).
 *
 * Step 1 of the same continuous migration as WhatsApp: the multi-step
 * phone/code/password forms in telegram-forms.ts (2 <style> blocks, 2 <script>
 * blocks) stay live until the portal consumer ships, then are deleted.
 */

import { getAppLogger } from "@teamscala/logger/app-loggers";
import QRCode from "qrcode";
import { errMsg } from "@teamscala/runtime-auth-flow-config/err-msg";
import { callMessagingConnect, callMessagingStatus } from "@teamscala/runtime-messaging-service-rpc/messaging-service-rpc";

export const ROUTES = {
	connect: "/telegram/connect",
	phone: "/telegram/connect/phone",
	code: "/telegram/connect/code",
	password: "/telegram/connect/password",
} as const;

export interface TelegramConnectInput {
	organisationId: string;
	callbackUrl: string;
	phoneNumber?: string;
	code?: string;
	password?: string;
	/** Per-connection TDLib accountId (orgId:connectionId) for multi-number support.
	 * Falls back to organisationId when not set (legacy single-number behavior). */
	accountId?: string;
}

export interface TelegramFlowDeps {
	/** Persist the successful connection (e.g. organisation_profile.telegram_auth_status). */
	onReady: (organisationId: string, phoneNumber: string) => Promise<void>;
}

function redirect(callbackUrl: string, success: boolean, error?: string): Response {
	let url: URL;
	try {
		url = new URL(callbackUrl);
	} catch {
		return new Response(success ? "Connected" : `Failed: ${error ?? "telegram_auth_failed"}`, {
			status: success ? 200 : 400,
		});
	}
	url.searchParams.set(success ? "success" : "error", success ? "telegram_connected" : error || "telegram_auth_failed");
	return new Response(null, { status: 302, headers: { Location: url.toString() } });
}

/** Cookie the gateway uses to carry the minted connection id to the status poll. */
export const TELEGRAM_CONNECT_COOKIE = "tg_connect";

export type TelegramStep = "phone" | "code" | "password" | "done";

export interface TelegramStepState {
	next: TelegramStep;
	accountId: string;
	error: string;
}

/** Map one messaging-service step result onto the flow state. One mapping, used
 *  by all three steps, so a status added upstream cannot be handled three
 *  different ways. */
function toStepState(
	res: { status?: string; error?: string },
	accountId: string,
	fallbackError: string,
): TelegramStepState {
	if (res.status === "ready") return { next: "done", accountId, error: "" };
	if (res.status === "waiting_password") return { next: "password", accountId, error: "" };
	if (res.status === "waiting_code") return { next: "code", accountId, error: "" };
	return { next: "phone", accountId, error: res.error || fallbackError };
}

function stepResponse(state: TelegramStepState, returnTo: string, successUrl: string): Response {
	if (!returnTo) return Response.json(state);
	const base = returnTo.replace(/\/+$/, "");
	if (state.next === "done") {
		return new Response(null, { status: 302, headers: { Location: successUrl || base } });
	}
	const url = `${base}/${state.next}${state.error ? `?error=${encodeURIComponent(state.error)}` : ""}`;
	return new Response(null, { status: 302, headers: { Location: url } });
}

/** POST /telegram/connect/phone/data — submit the phone number, get the next step. */
export async function telegramPhoneStepData(
	organisationId: string,
	phoneNumber: string,
	accountId: string,
	deps: TelegramFlowDeps,
	returnTo = "",
	successUrl = "",
): Promise<Response> {
	if (!organisationId) return Response.json({ error: "missing organisationId" }, { status: 400 });
	if (!phoneNumber) return Response.json({ error: "missing phoneNumber" }, { status: 400 });
	const id = accountId || organisationId;
	await callMessagingConnect("start", { accountId: id });
	const res = await callMessagingConnect("phone", { accountId: id, phoneNumber });
	const state = toStepState(res, id, "Could not send the login code. Check the number and try again.");
	if (state.next === "done") await deps.onReady(organisationId, phoneNumber);
	return stepResponse(state, returnTo, successUrl);
}

/** POST /telegram/connect/code/data — submit the login code. */
export async function telegramCodeStepData(
	organisationId: string,
	code: string,
	phoneNumber: string,
	accountId: string,
	deps: TelegramFlowDeps,
	returnTo = "",
	successUrl = "",
): Promise<Response> {
	if (!organisationId) return Response.json({ error: "missing organisationId" }, { status: 400 });
	if (!code) return Response.json({ error: "missing code" }, { status: 400 });
	const id = accountId || organisationId;
	const res = await callMessagingConnect("code", { accountId: id, code });
	// A bad code returns the CODE step again, not the phone step — re-entering the
	// number would discard a valid session over a typo.
	const state = toStepState(res, id, "Invalid code. Try again.");
	if (state.next === "phone") state.next = "code";
	if (state.next === "done") await deps.onReady(organisationId, phoneNumber);
	return stepResponse(state, returnTo, successUrl);
}

/** POST /telegram/connect/password/data — submit the 2FA password. */
export async function telegramPasswordStepData(
	organisationId: string,
	password: string,
	phoneNumber: string,
	accountId: string,
	deps: TelegramFlowDeps,
	returnTo = "",
	successUrl = "",
): Promise<Response> {
	if (!organisationId) return Response.json({ error: "missing organisationId" }, { status: 400 });
	if (!password) return Response.json({ error: "missing password" }, { status: 400 });
	const id = accountId || organisationId;
	const res = await callMessagingConnect("password", { accountId: id, password });
	const state = toStepState(res, id, "Incorrect password. Try again.");
	if (state.next === "phone") state.next = "password";
	if (state.next === "done") await deps.onReady(organisationId, phoneNumber);
	return stepResponse(state, returnTo, successUrl);
}

export async function telegramConnectQrImage(organisationId: string): Promise<Response> {
	if (!organisationId) return new Response("missing organisationId", { status: 400 });
	const accountId = `${organisationId}:${Bun.randomUUIDv7()}`;
	const res = await callMessagingConnect("qr", { accountId }, 90_000);
	if (res.status === "ready") return new Response("already connected", { status: 409 });
	if (!res.qrLink) {
		return new Response(res.error ?? "QR login unavailable", { status: 502 });
	}
	let svg: string;
	try {
		svg = await QRCode.toString(res.qrLink, { type: "svg", margin: 1, width: 220 });
	} catch (error) {
		return new Response(error instanceof Error ? error.message : "QR render failed", {
			status: 502,
		});
	}
	return new Response(svg, {
		status: 200,
		headers: {
			"Content-Type": "image/svg+xml; charset=utf-8",
			// Single-use: never let a proxy or the browser reuse a spent QR.
			"Cache-Control": "no-store, no-cache, must-revalidate",
			// Path-scoped to the connect routes + HttpOnly: the page never reads it,
			// only the status poll needs it, and it must not be script-reachable.
			"Set-Cookie": `${TELEGRAM_CONNECT_COOKIE}=${encodeURIComponent(accountId)}; Path=/telegram; HttpOnly; Secure; SameSite=Lax; Max-Age=900`,
		},
	});
}

export async function telegramConnectData(organisationId: string): Promise<Response> {
	if (!organisationId) {
		return Response.json({ error: "Missing required param: organisationId" }, { status: 400 });
	}
	// Per-connection accountId — the platform supports MULTIPLE Telegram numbers
	// per org, so each attempt mints its own TDLib client rather than replacing
	// an existing one. It is returned to the caller because it is also the poll
	// key for /telegram/connect/status.
	const accountId = `${organisationId}:${Bun.randomUUIDv7()}`;
	const res = await callMessagingConnect("qr", { accountId }, 90_000);
	if (res.status === "ready") return Response.json({ status: "ready", accountId });
	if (!res.qrLink) {
		return Response.json({
			status: "error",
			accountId,
			error: res.error ?? "QR login unavailable. Try the phone-number method instead.",
		});
	}
	let qrDataUri: string;
	try {
		const svg = await QRCode.toString(res.qrLink, { type: "svg", margin: 1, width: 220 });
		qrDataUri = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
	} catch (error) {
		return Response.json({
			status: "error",
			accountId,
			error: error instanceof Error ? error.message : "Could not render the QR code.",
		});
	}
	return Response.json({ status: "waiting_qr", accountId, qrDataUri });
}

/**
 * Gateway-side status proxy polled by the QR page. On the terminal "ready" state,
 * persists the connection via deps.onReady (idempotent — may fire across multiple
 * polls; the empty phoneNumber is intentional: the QR flow doesn't know it, and
 * onTelegramReady skips the phone write when empty so it never clobbers a real value).
 */
export async function handleTelegramStatus(
	accountId: string,
	deps: TelegramFlowDeps,
): Promise<Response> {
	const res = await callMessagingStatus(accountId);
	if (res.status === "ready") {
		await deps.onReady(accountId, "").catch((error) => {
			getAppLogger().error("[telegram-connect] onReady persistence failed", {
				accountId,
				error: errMsg(error),
			});
		});
	}
	return Response.json(
		{ status: res.status, ...(res.qrLink ? { qrLink: res.qrLink } : {}) },
		{ status: res.ok ? 200 : res.httpStatus },
	);
}


// One click from either console into the ClickStack dashboard, already signed in.
//
// WHY THIS EXISTS. HyperDX enforces its login server-side: an unauthenticated /api/dashboards
// returns 401, and its no-login local mode is a BUILD-time flag on the image, so the sign-in
// cannot be turned off without rebuilding it, and a local-mode build moves connections into the
// browser and discards the tiles scripts/clickstack_setup.sh provisions through the API. So the
// login is performed here instead of being asked of the viewer.
//
// WHY THE COOKIE CARRIES ACROSS. Cookies are scoped by host and NOT by port, so a cookie this
// route sets on the console's origin is sent by the browser to HyperDX's port on the redirect that
// follows. That is the whole trick. The domain is derived from the request rather than pinned, so
// it survives a real hostname; see the comment on the Set-Cookie below.
//
// NOT A SECRET. The credential is the fixed demo login documented in docs/clickstack.md, and it is
// overridable by environment so a real deployment is a config change and not a code change.
//
// ON A PUBLIC HOST THIS PUBLISHES AN AUTHENTICATED DASHBOARD. Anyone who reaches this route gets a
// HyperDX session. That is a convenience on a laptop and a decision on a server; DEPLOYMENT.md
// states the three ways to handle it and does not pick one silently.
import {NextRequest, NextResponse} from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HDX_URL = process.env.NEXT_PUBLIC_CLICKSTACK_URL || 'http://localhost:8090'
const HDX_EMAIL = process.env.HDX_EMAIL || 'phoenix@example.com'
const HDX_PASSWORD = process.env.HDX_PASSWORD || 'PhoenixClickathon2026!'

export async function GET(req: NextRequest): Promise<NextResponse> {
  // Degrading to the plain dashboard URL is the correct failure here, every time. If HyperDX is
  // down the viewer sees HyperDX being down; if the credential is wrong they see its login form.
  // Either is a better answer than an error page from a console that is not the thing they asked
  // for, and neither hides which of the two happened.
  const fallback = NextResponse.redirect(HDX_URL, 307)
  try {
    const res = await fetch(`${HDX_URL}/api/login/password`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({email: HDX_EMAIL, password: HDX_PASSWORD}),
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })

    const setCookie = res.headers.get('set-cookie')
    const sid = setCookie?.match(/connect\.sid=([^;]+)/)?.[1]
    if (!sid) return fallback

    // Land on the provisioned dashboard rather than HyperDX's landing page. The id is created by
    // scripts/clickstack_setup.sh and differs per install, so it is looked up rather than
    // hardcoded; if the lookup fails the redirect falls back to the root, which still works.
    let target = HDX_URL
    try {
      const list = await fetch(`${HDX_URL}/api/dashboards`, {
        headers: {cookie: `connect.sid=${sid}`},
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      })
      const boards = (await list.json()) as {_id?: string}[]
      if (boards?.[0]?._id) target = `${HDX_URL}/dashboards/${boards[0]._id}`
    } catch {
      // Keep the root. A dashboard we could not name is not a reason to fail the sign-in.
    }

    const out = NextResponse.redirect(target, 307)
    // Re-issued rather than forwarded verbatim: the upstream header carries an Expires this route
    // has no reason to reproduce, and Domain/Path are the two attributes that make it reach the
    // other port. HttpOnly stays, because nothing on either console reads this value.
    //
    // THE DOMAIN IS DERIVED, NOT PINNED. Hardcoding `localhost` worked on a laptop and would have
    // failed silently on the EC2 host this gets demoed from: a cookie scoped to a domain the
    // browser is not on is simply dropped, so the redirect would land on a login form with no
    // indication why. An IP address must be sent with NO Domain attribute at all, because the
    // attribute is only valid for names, and omitting it host-scopes the cookie, which is what we
    // want anyway. Ports are never part of cookie scope, which is what makes the hop to HyperDX
    // work in the first place.
    const host = req.headers.get('host')?.split(':')[0] ?? 'localhost'
    const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host)
    out.cookies.set('connect.sid', decodeURIComponent(sid), {
      ...(isIp ? {} : {domain: host}),
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: req.nextUrl.protocol === 'https:',
      maxAge: 60 * 60 * 24 * 7,
    })
    return out
  } catch {
    return fallback
  }
}

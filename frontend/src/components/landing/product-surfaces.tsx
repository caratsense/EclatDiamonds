import {
  AlertTriangle,
  Camera,
  Check,
  MapPin,
  MessageCircle,
  Phone,
  Store,
} from "lucide-react";

/**
 * The screens, drawn.
 *
 * ## Why these are built rather than screenshotted
 *
 * A screenshot of a live workspace is a screenshot of somebody's customers —
 * their names, their numbers, what they came in asking for — on a page anyone
 * can load. There is no version of that which is safe to publish, and a
 * screenshot of a demo tenant is a drawing of a fake business taken with a
 * camera, which is the same fiction with worse resolution.
 *
 * So these are the real layouts, with example content, marked as example
 * content. Every element corresponds to something the product actually renders:
 * the intent panel really does refuse to score an unassessed lead, the punch
 * card really does show distance beside the photo, the floor visit really does
 * list what the customer asked about and why it did not convert.
 *
 * ## What must never appear here
 *
 * A metric the product cannot produce. No throughput figure, no accuracy
 * percentage, no customer count, no revenue. The numbers below are small,
 * plainly a sample, and describe one imaginary afternoon rather than the
 * performance of a business.
 */

/** The window chrome the surfaces sit in. */
function Surface({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <figure className="landing-card overflow-hidden rounded-xl">
      <figcaption className="flex items-center justify-between gap-3 border-b border-[var(--l-hairline)] px-4 py-2.5">
        <span className="text-xs font-medium text-[var(--l-ivory-70)]">{label}</span>
        {/*
          Said on every surface, not in a disclaimer at the bottom of the page
          that nobody reads next to the picture it applies to.
        */}
        <span className="shrink-0 text-[10px] uppercase tracking-[0.14em] text-[var(--l-ivory-55)]">
          Example view
        </span>
      </figcaption>
      <div className="p-4">{children}</div>
    </figure>
  );
}

const CHANNEL_TONE = "border-[var(--l-hairline)] text-[var(--l-ivory-70)]";

function Pill({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] ${CHANNEL_TONE}`}
    >
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------ inbox */

const THREADS = [
  { who: "R. Iyer", channel: "WhatsApp", line: "Do you have this in a smaller size?", at: "11:04" },
  { who: "Walk-in · counter 2", channel: "In store", line: "Asked about the new range", at: "10:52" },
  { who: "+91 ·· ··· 4417", channel: "Phone", line: "Missed call, called back 10:31", at: "10:28" },
  { who: "Meta lead form", channel: "Ads", line: "Budget: 40–60k · City: Pune", at: "09:47" },
];

export function OmnichannelSurface() {
  return (
    <Surface label="One customer, every channel">
      <ul className="divide-y divide-[var(--l-hairline)]">
        {THREADS.map((t) => (
          <li key={t.who} className="flex items-start gap-3 py-2.5 first:pt-0 last:pb-0">
            <MessageCircle
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--l-gold)]"
              aria-hidden
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <span className="truncate text-sm">{t.who}</span>
                <span className="shrink-0 font-mono text-[10px] text-[var(--l-ivory-55)]">
                  {t.at}
                </span>
              </div>
              <p className="truncate text-xs text-[var(--l-ivory-55)]">{t.line}</p>
            </div>
            <Pill>{t.channel}</Pill>
          </li>
        ))}
      </ul>
    </Surface>
  );
}

/* ----------------------------------------------------------------- intent */

export function IntentSurface() {
  return (
    <Surface label="How warm this enquiry is, and why">
      <div className="flex items-center gap-4">
        <Gauge value={72} />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm">Interested</p>
          <ul className="space-y-1 text-xs text-[var(--l-ivory-55)]">
            <li>· Asked for a price twice</li>
            <li>· Replied within the hour, three days running</li>
            <li>· No visit recorded yet</li>
          </ul>
        </div>
      </div>
      {/*
        The honest state, shown deliberately. This is what the product does with
        an unassessed lead, and it is the part most worth putting on a landing
        page: a score nobody computed is worse than no score.
      */}
      <p className="mt-4 border-t border-[var(--l-hairline)] pt-3 text-xs text-[var(--l-ivory-55)]">
        An enquiry nobody has assessed reads &ldquo;not scored yet&rdquo;. It never gets a
        made-up number, because a number a salesperson acts on has to have come from somewhere.
      </p>
    </Surface>
  );
}

/** A ring, drawn to the value it is labelled with. */
function Gauge({ value }: { value: number }) {
  const r = 15.9155;
  return (
    <svg viewBox="0 0 42 42" className="h-20 w-20 shrink-0" role="img" aria-label={`Score ${value} out of 100`}>
      <circle cx="21" cy="21" r={r} fill="none" stroke="var(--l-hairline)" strokeWidth="4" />
      <circle
        cx="21"
        cy="21"
        r={r}
        fill="none"
        stroke="var(--l-gold)"
        strokeWidth="4"
        strokeLinecap="round"
        strokeDasharray={`${value} ${100 - value}`}
        strokeDashoffset="25"
      />
      <text
        x="21"
        y="23"
        textAnchor="middle"
        fill="var(--l-ivory)"
        fontSize="9"
        fontFamily="var(--font-mono-face)"
      >
        {value}
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ floor */

export function FloorSurface() {
  return (
    <Surface label="A visit, as the counter recorded it">
      <div className="space-y-3">
        <div className="flex items-start justify-between gap-2">
          <div>
            <p className="text-sm">A. Menon</p>
            <p className="font-mono text-[11px] text-[var(--l-ivory-55)]">14:32 – 15:05</p>
          </div>
          <Pill>
            <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
            Walked out
          </Pill>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Pill>
            <Store className="h-2.5 w-2.5" aria-hidden />
            Counter 2
          </Pill>
          <Pill>Attended by S. Rao</Pill>
        </div>
        <ul className="space-y-1.5 border-t border-[var(--l-hairline)] pt-2.5 text-xs">
          <li className="flex items-start gap-2">
            <Check className="mt-0.5 h-3 w-3 shrink-0 text-[var(--l-gold)]" aria-hidden />
            <span>Item shown · bought</span>
          </li>
          <li className="flex items-start gap-2">
            <span
              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full border border-[var(--l-hairline)]"
              aria-hidden
            />
            <span>
              Second item shown
              <span className="block text-[var(--l-ivory-55)]">
                Not converted — wanted a smaller size
              </span>
            </span>
          </li>
        </ul>
      </div>
    </Surface>
  );
}

/* ------------------------------------------------------------- attendance */

export function AttendanceSurface() {
  return (
    <Surface label="A punch a manager can review">
      <div className="flex gap-4">
        <div className="grid h-24 w-20 shrink-0 place-items-center rounded-md border border-[var(--l-hairline)] bg-[color-mix(in_srgb,var(--l-ivory)_5%,transparent)]">
          <Camera className="h-5 w-5 text-[var(--l-ivory-55)]" aria-hidden />
        </div>
        <dl className="min-w-0 flex-1 space-y-1 text-xs">
          <Row k="Punched" v="09:58 · check in" />
          <Row k="Distance" v="41 m from the branch" />
          <Row k="Inside the fence" v="Yes" />
          <Row k="Mock location" v="Not reported" />
        </dl>
      </div>
      <p className="mt-3 border-t border-[var(--l-hairline)] pt-3 text-xs text-[var(--l-ivory-55)]">
        A camera on the device produced the photo at the moment of the punch. Nothing compares it
        to an enrolled face — who punched comes from the account that signed in, and this is
        evidence for a person to weigh, not a verdict.
      </p>
    </Surface>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-[var(--l-ivory-55)]">{k}</dt>
      <dd className="truncate text-right">{v}</dd>
    </div>
  );
}

/* ------------------------------------------------------------ attribution */

const FUNNEL = [
  { stage: "Ad clicks", n: 240 },
  { stage: "Conversations", n: 118 },
  { stage: "Enquiries", n: 74 },
  { stage: "Visits", n: 31 },
  { stage: "Orders", n: 9 },
];

export function AttributionSurface() {
  const widest = FUNNEL[0].n;
  return (
    <Surface label="Where the business came from">
      <ul className="space-y-2.5">
        {FUNNEL.map((s) => (
          <li key={s.stage} className="flex items-center gap-3 text-xs">
            <span className="w-24 shrink-0 text-[var(--l-ivory-55)]">{s.stage}</span>
            <span className="h-2 flex-1 overflow-hidden rounded-full bg-[var(--l-hairline)]">
              <span
                className="block h-full rounded-full bg-[var(--l-gold)]/70"
                style={{ width: `${Math.max((s.n / widest) * 100, 4)}%` }}
              />
            </span>
            <span className="w-8 shrink-0 text-right font-mono tabular-nums">{s.n}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 border-t border-[var(--l-hairline)] pt-3 text-xs text-[var(--l-ivory-55)]">
        Each figure is counted in the database over the period you pick. A stage the product
        cannot measure for your account shows a dash, not a zero.
      </p>
    </Surface>
  );
}

/* ---------------------------------------------------------------- calling */

export function QueueSurface() {
  return (
    <Surface label="Today’s follow-ups">
      <div className="space-y-2.5">
        {[
          { who: "P. Shah", when: "2 days late", dial: true },
          { who: "K. Nair", when: "Due today", dial: true },
          { who: "Colleague’s customer", when: "Due today", dial: false },
        ].map((t) => (
          <div
            key={t.who}
            className="flex items-center justify-between gap-3 rounded-md border border-[var(--l-hairline)] px-3 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-sm">{t.who}</p>
              <p className="font-mono text-[10px] text-[var(--l-ivory-55)]">
                {t.dial ? "+91 98··· ··417" : "•••• 4417 · number withheld"}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="text-[10px] text-[var(--l-ivory-55)]">{t.when}</span>
              <Phone
                className={`h-3.5 w-3.5 ${t.dial ? "text-[var(--l-gold)]" : "text-[var(--l-ivory-55)] opacity-40"}`}
                aria-hidden
              />
            </div>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs text-[var(--l-ivory-55)]">
        A customer&rsquo;s number is shown in full to the person who owns the follow-up and to
        their manager. Anyone else sees the last four digits, and no dial button.
      </p>
    </Surface>
  );
}

/* -------------------------------------------------------------- isolation */

export function IsolationSurface() {
  return (
    <Surface label="Two workspaces on one platform">
      <div className="grid grid-cols-2 gap-3">
        {[
          { name: "A clinic", words: ["Patients", "Appointments", "Departments"] },
          { name: "A textile house", words: ["Buyers", "Orders", "Articles"] },
        ].map((t) => (
          <div key={t.name} className="rounded-md border border-[var(--l-hairline)] p-3">
            <p className="mb-2 flex items-center gap-1.5 text-xs">
              <MapPin className="h-3 w-3 text-[var(--l-gold)]" aria-hidden />
              {t.name}
            </p>
            <ul className="space-y-1 text-[11px] text-[var(--l-ivory-55)]">
              {t.words.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <p className="mt-3 border-t border-[var(--l-hairline)] pt-3 text-xs text-[var(--l-ivory-55)]">
        Same product, each one&rsquo;s own words — and neither can read a row belonging to the
        other. The scoping is enforced on the server, not in the screen you are looking at.
      </p>
    </Surface>
  );
}

import { UserError } from "./errors";
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { z } from "zod";
import { jobSchema } from "../shared/model";
import type { DiscoveryCandidate, DiscoverySource } from "../shared/discovery";
import { canonicalUrl, publicRequest } from "./network";
import { htmlText } from "./extraction";

export const githubFeed =
  "https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md";
export const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function boardFromUrl(value: string, name = ""): DiscoverySource | null {
  try {
    const url = new URL(canonicalUrl(value));
    if (url.protocol !== "https:" || url.port) return null;
    const slug = url.pathname.split("/").filter(Boolean)[0];
    if (!slug || !/^[a-zA-Z0-9_-]{1,100}$/.test(slug)) return null;
    const kind = ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(
      url.hostname,
    )
      ? "greenhouse"
      : ["jobs.lever.co", "jobs.eu.lever.co"].includes(url.hostname)
        ? "lever"
        : url.hostname === "jobs.ashbyhq.com"
          ? "ashby"
          : null;
    if (!kind) return null;
    const host =
      kind === "greenhouse" ? "job-boards.greenhouse.io" : url.hostname;
    const regionalSlug =
      kind === "lever" && host === "jobs.eu.lever.co" ? `eu:${slug}` : slug;
    return {
      id: `${kind}:${regionalSlug.toLowerCase()}`,
      kind,
      slug: regionalSlug,
      name: name.slice(0, 200) || slug,
      url: `https://${host}/${slug}`,
      enabled: true,
      initialized: false,
      lastChecked: "",
      lastSuccess: "",
      nextCheck: "",
      failures: 0,
      error: "",
      etag: "",
      count: 0,
    };
  } catch {
    return null;
  }
}
export function jobIdentity(value: string): string {
  const url = new URL(canonicalUrl(value));
  const board = boardFromUrl(value);
  if (board) {
    const parts = url.pathname.split("/").filter(Boolean);
    const posting = board.kind === "greenhouse" ? parts[2] : parts[1];
    if (posting && /^[a-zA-Z0-9_-]+$/.test(posting))
      return digest(`${board.id}:${posting}`);
  }
  for (const key of ["ref", "source", "gh_src", "lever-source", "lever-origin"])
    if (
      url.searchParams.get(key)?.toLowerCase().includes("simplify") ||
      key !== "ref"
    )
      url.searchParams.delete(key);
  url.pathname = url.pathname.replace(/\/$/, "");
  return digest(url.toString());
}

export function experience(
  title: string,
  description: string,
  curated = false,
) {
  const explicit =
    /\b(new[ -]?grad(?:uate)?s?|entry[ -]level|early[ -]career|junior|graduate|university|associate)\b|\b(?:engineer|developer)\s+(?:i|1)\b/i.test(
      title,
    );
  // Only explicit experience statements, not every number in a description.
  const matches = [
    ...description.matchAll(
      /(?:at least\s+|minimum(?: of)?\s+)?(\d{1,2})(?:\s*[-–]\s*\d{1,2})?\+?\s+years?(?:\s+of)?\s+(?:(?:relevant|professional|industry|software|engineering|development|work|programming|hands-on)\s+){0,4}experience/gi,
    ),
  ].filter(
    (m) =>
      !/preferred|nice to have|bonus/i.test(
        description.slice(
          Math.max(0, m.index! - 35),
          m.index! + m[0].length + 20,
        ),
      ),
  );
  const requiredYears = matches.length
    ? Math.max(...matches.map((m) => Number(m[1])))
    : null;
  return {
    requiredYears,
    entryEvidence: curated
      ? "Listed in Simplify’s SWE new-grad section"
      : explicit
        ? "Entry-level title"
        : requiredYears !== null
          ? `Posting mentions ${requiredYears}+ years of experience`
          : unknownExperience,
  };
}
export const unknownExperience = "Experience not established";
export function isSoftwareRole(title: string) {
  return (
    /software|\bswe\b|\bsde\b|(?:backend|back.end|frontend|front.end|full.stack|web|mobile|android|ios|platform|devops|site reliability|application)\s+(?:engineer|developer)|\bprogrammer\b/i.test(
      title,
    ) &&
    !/\b(senior|sr\.?|staff|principal|lead|manager|director|intern|internship|co-op)\b/i.test(
      title,
    )
  );
}
const text = (value: unknown, max = 1000) =>
  typeof value === "string" ? value.slice(0, max) : "";
const timestamp = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : "";
function candidate(
  fields: Partial<DiscoveryCandidate> & {
    url: string;
    title: string;
    company: string;
  },
  curated = false,
): DiscoveryCandidate {
  const url = canonicalUrl(fields.url);
  const description = text(fields.description, 50000);
  return {
    ...jobSchema.parse({
      ...fields,
      title: fields.title.slice(0, 1000),
      company: fields.company.slice(0, 1000),
      location: text(fields.location),
      salary: text(fields.salary),
    }),
    id: jobIdentity(url),
    url,
    description,
    publishedAt: fields.publishedAt || "",
    annualSalaryMax: fields.annualSalaryMax ?? null,
    ...experience(fields.title, description, curated),
  };
}

export function parseGithub(markdown: string): DiscoveryCandidate[] {
  const section = markdown.match(
    /^##\s+[^\n]*Software Engineering New Grad Roles[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m,
  )?.[1];
  if (!section)
    throw new UserError(
      "github list format changed (couldn't find the swe section)",
    );
  const $ = cheerio.load(section);
  if (!(
    $("th").text().includes("Company") && $("th").text().includes("Application")
  ))
    throw new UserError("github list format changed (no job table)");
  const jobs: DiscoveryCandidate[] = [];
  let company = "";
  $("tbody tr").each((_i, row) => {
    const cells = $(row).find("td");
    if (cells.length < 4) return;
    const label = cells
      .eq(0)
      .text()
      .replace(/[🔥🛂🇺🇸🎓]/gu, "")
      .trim();
    if (label && !/^[↳↪→]$/.test(label)) company = label;
    const title = cells.eq(1).text().trim();
    if (cells.eq(3).text().includes("🔒")) return;
    const links = cells
      .eq(3)
      .find("a")
      .toArray()
      .map((el) => $(el).attr("href") || "");
    const url =
      links.find(
        (link) =>
          /^https:\/\//.test(link) &&
          new URL(link).hostname !== "simplify.jobs",
      ) || links.find((link) => /^https:\/\//.test(link));
    if (!url || !company || !title) return;
    const locationHtml = cells.eq(2).clone();
    locationHtml.find("summary").remove();
    const location = htmlText(locationHtml.html() || "")
      .replace(/\n+/g, " · ")
      .slice(0, 1000);
    jobs.push(
      candidate(
        {
          company,
          title,
          url,
          location,
          employmentType: "Full-time",
          workArrangement: /\bremote\b/i.test(location) ? "Remote" : "Unknown",
        },
        true,
      ),
    );
  });
  // A layout change must not silently close every role.
  if (!jobs.length)
    throw new UserError(
      "github list format changed (no open jobs found), kept the old listings",
    );
  return jobs;
}

const rowSchema = z.record(z.string(), z.unknown());
const listSchema = z.array(rowSchema).max(20000);
function salaryRange(range: Record<string, unknown> | undefined) {
  const currency = text(range?.currency || range?.currencyCode).toUpperCase();
  const period = text(range?.interval || range?.unitText);
  const max =
    typeof range?.max === "number"
      ? range.max
      : typeof range?.maxValue === "number"
        ? range.maxValue
        : null;
  const min =
    typeof range?.min === "number"
      ? range.min
      : typeof range?.minValue === "number"
        ? range.minValue
        : null;
  return {
    currency,
    salaryPeriod: period,
    salary: range
      ? `${currency} ${[min, max].filter((n) => n !== null).join(" – ")} ${period}`.trim()
      : "",
    annualSalaryMax:
      /^(year|yearly|annual|annually|1\s?year)$/i.test(period) &&
      max !== null &&
      max > 0
        ? max
        : null,
  };
}

export function parseBoard(
  source: DiscoverySource,
  payload: unknown,
): DiscoveryCandidate[] {
  const rows =
    source.kind === "lever"
      ? listSchema.parse(payload)
      : listSchema.parse(z.object({ jobs: listSchema }).parse(payload).jobs);
  const jobs: DiscoveryCandidate[] = [];
  for (const row of rows) {
    if (source.kind === "ashby" && row.isListed === false) continue;
    let fields: Partial<DiscoveryCandidate> & {
      title: string;
      company: string;
      url: string;
    };
    if (source.kind === "greenhouse") {
      const location = row.location as Record<string, unknown> | undefined;
      fields = {
        company: source.name,
        title: text(row.title),
        url: text(row.absolute_url, 4000),
        location: text(location?.name),
        postingId: String(row.id ?? ""),
        description: htmlText(text(row.content, 300000)),
        publishedAt: timestamp(row.first_published),
      };
    } else if (source.kind === "lever") {
      const category = row.categories as Record<string, unknown> | undefined;
      fields = {
        company: source.name,
        title: text(row.text),
        url: text(row.hostedUrl || row.applyUrl, 4000),
        postingId: text(row.id),
        location: text(category?.location),
        employmentType: text(category?.commitment),
        description: htmlText(
          [
            text(row.description, 200000),
            ...(Array.isArray(row.lists)
              ? row.lists.map((list) =>
                  text((list as Record<string, unknown>)?.content, 50000),
                )
              : []),
            text(row.additional, 50000),
          ].join("\n"),
        ),
        workArrangement:
          row.workplaceType === "remote"
            ? "Remote"
            : row.workplaceType === "hybrid"
              ? "Hybrid"
              : row.workplaceType === "on-site"
                ? "On-site"
                : "Unknown",
        ...salaryRange(row.salaryRange as Record<string, unknown> | undefined),
      };
    } else {
      const compensation = row.compensation as
        Record<string, unknown> | undefined;
      const ranges = Array.isArray(compensation?.summaryComponents)
        ? compensation.summaryComponents.filter(
            (r: any) => r.compensationType === "Salary",
          )
        : [];
      // Multiple currencies/tiers are intentionally not collapsed into a guessed salary.
      const pay =
        ranges.length === 1 ? salaryRange(ranges[0]) : salaryRange(undefined);
      fields = {
        company: source.name,
        title: text(row.title),
        url: text(row.jobUrl || row.applyUrl, 4000),
        location: [
          text(row.location),
          ...(Array.isArray(row.secondaryLocations)
            ? row.secondaryLocations.map((item: any) => text(item?.location))
            : []),
        ]
          .filter(Boolean)
          .join(" · ")
          .slice(0, 1000),
        description:
          text(row.descriptionPlain, 50000) ||
          htmlText(text(row.descriptionHtml, 200000)),
        publishedAt: timestamp(row.publishedAt),
        employmentType: text(row.employmentType),
        workArrangement:
          row.workplaceType === "Remote" || row.isRemote === true
            ? "Remote"
            : row.workplaceType === "Hybrid"
              ? "Hybrid"
              : row.workplaceType === "OnSite"
                ? "On-site"
                : "Unknown",
        ...pay,
        salary: text(compensation?.compensationTierSummary) || pay.salary,
      };
    }
    if (!fields.title || !fields.url)
      throw new UserError("board format changed (missing job fields)");
    jobs.push(candidate(fields));
  }
  return jobs;
}

export class FeedError extends UserError {
  constructor(
    message: string,
    public retryAfter = 0,
  ) {
    super(message);
  }
}
export async function fetchSource(
  source: DiscoverySource,
  request: typeof publicRequest,
  signal: AbortSignal,
) {
  const [region, name] = source.slug.startsWith("eu:")
    ? ["eu", source.slug.slice(3)]
    : ["", source.slug];
  const base =
    source.kind === "github"
      ? githubFeed
      : source.kind === "greenhouse"
        ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(name)}/jobs?content=true`
        : source.kind === "ashby"
          ? `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(name)}?includeCompensation=true`
          : `https://api${region ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(name)}?mode=json&limit=100`;
  const jobs: DiscoveryCandidate[] = [];
  for (let page = 0; page < 50; page++) {
    signal.throwIfAborted();
    const response = await request(
      `${base}${source.kind === "lever" ? `&skip=${page * 100}` : ""}`,
      {
        httpsOnly: true,
        maxBytes: 12_000_000,
        signal,
        headers: {
          Accept: source.kind === "github" ? "text/plain" : "application/json",
          ...(source.etag && source.kind !== "lever"
            ? { "If-None-Match": source.etag }
            : {}),
        },
      },
    );
    if (response.status === 304)
      return { unchanged: true, jobs: [], etag: source.etag };
    if (response.status !== 200) {
      const retry = String(response.headers["retry-after"] || "");
      const delay = /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Math.max(0, Date.parse(retry) - Date.now()) || 0;
      throw new FeedError(
        `source returned http ${response.status}, will retry later`,
        delay,
      );
    }
    const etag =
      typeof response.headers.etag === "string" ? response.headers.etag : "";
    if (source.kind === "github")
      return { jobs: parseGithub(response.text), unchanged: false, etag };
    const payload: unknown = JSON.parse(response.text);
    jobs.push(...parseBoard(source, payload));
    if (
      source.kind !== "lever" ||
      (Array.isArray(payload) && payload.length < 100)
    )
      return {
        jobs,
        unchanged: false,
        etag: source.kind === "lever" ? "" : etag,
      };
  }
  throw new UserError("too many pages from this source, kept the old listings");
}

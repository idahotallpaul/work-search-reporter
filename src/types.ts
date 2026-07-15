export type CliOptions = {
  dryRun: boolean;
  batchSize: number;
  limit?: number;
  noOpenAI: boolean;
  outputPath: string;
  weekStart?: string;
};

export type WeekWindow = {
  claimWeekStart: string;
  claimWeekEnd: string;
  queryStart: DateParts;
  queryEndExclusive: DateParts;
};

export type DateParts = {
  year: number;
  month: number;
  day: number;
};

export type MailMessage = {
  sourceMessageId: string;
  messageId: string;
  account: string;
  mailbox: string;
  subject: string;
  sender: string;
  dateReceived: string;
  dateSent: string;
  body: string;
  headers: string;
};

export type CandidateMessage = MailMessage & {
  evidenceExcerpt: string;
  localScore: number;
  matchedTerms: string[];
};

export type ExtractedAction = {
  source_message_id?: string;
  action_found: boolean;
  action_date: string;
  action_type: string;
  company: string;
  job_title: string;
  how_applied: string;
  evidence_excerpt: string;
  confidence: number;
  notes: string;
};

export type EnrichedEmployer = {
  employer_website: string;
  employer_contact: string;
  mailing_address_line_1: string;
  mailing_address_line_2: string;
  city: string;
  state: string;
  zip: string;
  source_url: string;
  confidence: number;
  notes: string;
};

export type WorkSearchRow = {
  claim_week_start: string;
  claim_week_end: string;
  action_date: string;
  action_type: string;
  company: string;
  job_title: string;
  how_applied: string;
  employer_website: string;
  employer_contact: string;
  mailing_address_line_1: string;
  mailing_address_line_2: string;
  city: string;
  state: string;
  zip: string;
  source_subject: string;
  source_sender: string;
  source_date: string;
  evidence_excerpt: string;
  source_url: string;
  confidence: string;
  notes: string;
};

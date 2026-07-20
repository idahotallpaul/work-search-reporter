// ==UserScript==
// @name         Idaho Weekly Certification Helper
// @namespace    work-search-reporter
// @version      0.1.0
// @description  Review-first helpers for Idaho weekly certification forms.
// @match        https://www2.labor.idaho.gov/ClaimantPortal/CertificationApplication/*
// @match        https://labor.idaho.gov/ClaimantPortal/CertificationApplication/*
// @grant        none
// ==/UserScript==

(() => {
  // ============================================================================
  // Config
  // ============================================================================
  // Static configuration lives here: storage keys, portal selectors, and the
  // normal answer sets for pages that do not depend on CSV data.
  const Config = (() => {
    const panelId = "wsr-idaho-certification-helper";
    const panelOpenStorageKey = "wsr-idaho-helper-panel-open";
    const csvStorageKey = "wsr-idaho-work-search-csv-rows";

    // Portal state select options use full names, while the CSV stores abbreviations.
    const stateNamesByAbbreviation = {
      AL: "Alabama",
      AK: "Alaska",
      AZ: "Arizona",
      AR: "Arkansas",
      CA: "California",
      CO: "Colorado",
      CT: "Connecticut",
      DE: "Delaware",
      DC: "District of Columbia",
      FL: "Florida",
      GA: "Georgia",
      HI: "Hawaii",
      ID: "Idaho",
      IL: "Illinois",
      IN: "Indiana",
      IA: "Iowa",
      KS: "Kansas",
      KY: "Kentucky",
      LA: "Louisiana",
      ME: "Maine",
      MD: "Maryland",
      MA: "Massachusetts",
      MI: "Michigan",
      MN: "Minnesota",
      MS: "Mississippi",
      MO: "Missouri",
      MT: "Montana",
      NE: "Nebraska",
      NV: "Nevada",
      NH: "New Hampshire",
      NJ: "New Jersey",
      NM: "New Mexico",
      NY: "New York",
      NC: "North Carolina",
      ND: "North Dakota",
      OH: "Ohio",
      OK: "Oklahoma",
      OR: "Oregon",
      PA: "Pennsylvania",
      RI: "Rhode Island",
      SC: "South Carolina",
      SD: "South Dakota",
      TN: "Tennessee",
      TX: "Texas",
      UT: "Utah",
      VT: "Vermont",
      VA: "Virginia",
      WA: "Washington",
      WV: "West Virginia",
      WI: "Wisconsin",
      WY: "Wyoming",
    };

    // Step 1 normal answers. These selectors are intentionally specific; if
    // Idaho changes the markup, the helper should report a missing field.
    const workAvailabilityAnswers = [
      {
        label: "Able To Work",
        normalAnswer: "Yes",
        selector: "#RdoAbleToWorkTrue",
      },
      {
        label: "Available for Work",
        normalAnswer: "Yes",
        selector: "#RdoAvailableTrue",
      },
      {
        label: "Away from Area",
        normalAnswer: "No",
        selector: "#RdoAwayFalse",
      },
      {
        label: "Refused Work",
        normalAnswer: "No",
        selector: "#RdoRefusedFalse",
      },
      {
        label: "Missed Work",
        normalAnswer: "No",
        selector: "#RdoMissedFalse",
      },
      {
        label: "Attended School or Training",
        normalAnswer: "No",
        selector: "#RdoSchoolFalse",
      },
      {
        label: "Quit Job",
        normalAnswer: "No",
        selector: "#RdoQuitFalse",
      },
      {
        label: "Fired from Job",
        normalAnswer: "No",
        selector: "#RdoFiredFalse",
      },
    ];

    // Step 2 normal answers for the common weekly no-income case.
    const incomeAnswers = [
      {
        label: "Worked for Employer",
        normalAnswer: "No",
        selector: "#RdoEmployerFalse",
      },
      {
        label: "Self Employed",
        normalAnswer: "No",
        selector: "#RdoSelfEmployedFalse",
      },
      {
        label: "Other Income",
        normalAnswer: "No",
        selector: "#RdoOtherPayFalse",
      },
    ];

    // Final-page legal acknowledgement boxes are kept separate from ordinary
    // weekly answers because they sit right before the user submits.
    const certificationAcknowledgements = [
      {
        label: "Recorded Answers",
        selector: "#AcknowledgeRecord",
      },
      {
        label: "Accurate Answers",
        selector: "#AcknowledgeTruth",
      },
      {
        label: "Penalty",
        selector: "#AcknowledgePenalty",
      },
    ];

    return {
      certificationAcknowledgements,
      csvStorageKey,
      incomeAnswers,
      panelId,
      panelOpenStorageKey,
      stateNamesByAbbreviation,
      workAvailabilityAnswers,
    };
  })();

  // ============================================================================
  // Format
  // ============================================================================
  // Small string/date/contact helpers shared by CSV import and form filling.
  const Format = (() => {
    const cellValue = (row, key) => {
      // CSV cells are optional strings; everything downstream expects trimmed text.
      return String(row[key] || "").trim();
    };

    const truncate = (value, maxLength) => {
      // Portal inputs have max lengths, so trim before writing into the form.
      const text = String(value || "").trim();
      return text.length > maxLength ? text.slice(0, maxLength) : text;
    };

    const toPortalDate = (isoDate) => {
      // Convert yyyy-mm-dd CSV dates into the portal's m/d/yyyy input format.
      const match = String(isoDate || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!match) return String(isoDate || "").trim();

      return `${Number(match[2])}/${Number(match[3])}/${match[1]}`;
    };

    const toIsoDate = (portalDate) => {
      // Hidden week fields include a time suffix; ISO strings compare cleanly.
      const match = String(portalDate || "").match(
        /^(\d{1,2})\/(\d{1,2})\/(\d{4})/,
      );
      if (!match) return "";

      return [
        match[3],
        match[1].padStart(2, "0"),
        match[2].padStart(2, "0"),
      ].join("-");
    };

    const findEmail = (value) => {
      // Employer contact cells can be free text; pull the first email if present.
      return String(value || "").match(
        /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
      )?.[0];
    };

    const findPhone = (value) => {
      // Strip phone formatting because the portal field is configured as numeric.
      const phoneMatch = String(value || "").match(
        /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
      );
      if (!phoneMatch) return "";

      const digits = phoneMatch[0].replace(/\D/g, "");
      return digits.length === 11 && digits.startsWith("1")
        ? digits.slice(1)
        : digits;
    };

    const getStateName = (row) => {
      // The state dropdown wants full state names, not postal abbreviations.
      const state = cellValue(row, "state");
      return Config.stateNamesByAbbreviation[state.toUpperCase()] || state;
    };

    const getZipCode = (row) => {
      // The portal ZIP field is numeric-only, so ZIP+4 is reduced to five digits.
      return cellValue(row, "zip").match(/\d{5}/)?.[0] || "";
    };

    return {
      cellValue,
      findEmail,
      findPhone,
      getStateName,
      getZipCode,
      toIsoDate,
      toPortalDate,
      truncate,
    };
  })();

  // ============================================================================
  // CsvStore
  // ============================================================================
  // Reads the user-selected CSV file, stores parsed rows in portal-local
  // localStorage, and filters those rows to the currently displayed claim week.
  const CsvStore = (() => {
    const parseCsvRows = (csvText) => {
      // Keep CSV parsing local to the userscript so no portal data is uploaded.
      const rows = [];
      let row = [];
      let cell = "";
      let index = 0;
      let inQuotes = false;

      // This small parser handles quoted cells and escaped quotes. Avoiding a
      // dependency keeps this helper installable as one self-contained file.
      while (index < csvText.length) {
        const char = csvText[index];
        const nextChar = csvText[index + 1];

        if (char === '"' && inQuotes && nextChar === '"') {
          // Two quotes inside a quoted cell represent one literal quote.
          cell += '"';
          index += 2;
        } else if (char === '"') {
          // Toggle quoted mode; commas/newlines are data while quoted.
          inQuotes = !inQuotes;
          index += 1;
        } else if (char === "," && !inQuotes) {
          // Unquoted comma ends the current cell.
          row.push(cell);
          cell = "";
          index += 1;
        } else if ((char === "\n" || char === "\r") && !inQuotes) {
          // Unquoted newline ends the current row.
          row.push(cell);
          cell = "";
          if (row.some((value) => value.trim())) rows.push(row);
          row = [];
          index += char === "\r" && nextChar === "\n" ? 2 : 1;
        } else {
          cell += char;
          index += 1;
        }
      }

      if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        if (row.some((value) => value.trim())) rows.push(row);
      }

      const headers = rows[0]?.map((header) => header.trim()) || [];
      return rows.slice(1).map((values) => {
        return Object.fromEntries(
          headers.map((header, headerIndex) => [
            header,
            String(values[headerIndex] || "").trim(),
          ]),
        );
      });
    };

    const isWorkSearchCsvRow = (row) => {
      // Only rows with the minimum fields needed to identify an action are stored.
      return Boolean(
        Format.cellValue(row, "action_date") &&
          Format.cellValue(row, "company"),
      );
    };

    // Store only parsed CSV rows in the browser for this portal origin.
    const getStoredRows = () => {
      const serializedRows = localStorage.getItem(Config.csvStorageKey);
      if (!serializedRows) return [];

      try {
        const rows = JSON.parse(serializedRows);
        return Array.isArray(rows) ? rows.filter(isWorkSearchCsvRow) : [];
      } catch (_error) {
        return [];
      }
    };

    const setStoredRows = (rows) => {
      // Store parsed row objects rather than the raw CSV text.
      localStorage.setItem(Config.csvStorageKey, JSON.stringify(rows));
    };

    // Hidden inputs on the portal are the source of truth for the claim week.
    const getCurrentClaimWeek = () => {
      return {
        end: Format.toIsoDate(document.querySelector("#WeekEndDate")?.value),
        start: Format.toIsoDate(
          document.querySelector("#WeekStartDate")?.value,
        ),
      };
    };

    const getRowsForCurrentWeek = () => {
      // If week fields are absent, return all rows so the helper still works on
      // partially loaded pages or future portal markup.
      const claimWeek = getCurrentClaimWeek();
      return getStoredRows().filter((row) => {
        const actionDate = Format.cellValue(row, "action_date");
        if (!claimWeek.start || !claimWeek.end) return true;
        return actionDate >= claimWeek.start && actionDate <= claimWeek.end;
      });
    };

    const getSelectedRow = (panel) => {
      // The select stores the current-week row index as its option value.
      const select = panel.querySelector("[data-wsr-csv-row]");
      const rows = getRowsForCurrentWeek();
      if (!(select instanceof HTMLSelectElement)) return undefined;
      return rows[Number(select.value)];
    };

    const summarizeRow = (row) => {
      // Keep dropdown labels short enough to scan but specific enough to choose.
      return [
        Format.cellValue(row, "action_date"),
        Format.cellValue(row, "company"),
        Format.cellValue(row, "job_title"),
      ]
        .filter(Boolean)
        .join(" | ");
    };

    const importFile = (panel, file, onAfterImport) => {
      // FileReader keeps CSV import local to the browser session.
      const reader = new FileReader();

      reader.addEventListener("load", () => {
        const csvText = String(reader.result || "");
        const rows = parseCsvRows(csvText).filter(isWorkSearchCsvRow);
        setStoredRows(rows);
        onAfterImport();

        Status.set(panel, [
          {
            kind: "success",
            message: `Imported ${rows.length} work-search CSV rows locally.`,
          },
          "Rows are stored in this browser only. Re-import after regenerating the CSV.",
        ]);
      });

      reader.addEventListener("error", () => {
        Status.set(panel, ["Could not read the selected CSV file."], "error");
      });

      reader.readAsText(file);
    };

    return {
      getRowsForCurrentWeek,
      getSelectedRow,
      importFile,
      summarizeRow,
    };
  })();

  // ============================================================================
  // Status
  // ============================================================================
  // Owns the green/red/info validation rows in the helper drawer.
  const Status = (() => {
    const normalizeStatusItem = (item) => {
      if (typeof item === "string") return { kind: "info", message: item };
      return item;
    };

    // Render status as individual rows so successes and errors can be scanned fast.
    const set = (panel, items, tone = "info") => {
      const status = panel.querySelector("[data-wsr-status]");
      if (!status) return;

      status.replaceChildren();
      status.dataset.tone = tone;

      for (const item of items.map(normalizeStatusItem)) {
        const row = document.createElement("div");
        const marker = document.createElement("span");
        const message = document.createElement("span");

        row.className = `wsr-status-row is-${item.kind}`;
        marker.className = "wsr-status-marker";
        marker.textContent =
          item.kind === "success" ? "OK" : item.kind === "error" ? "!!" : "i";
        message.textContent = item.message;

        row.append(marker, message);
        status.append(row);
      }
    };

    return { set };
  })();

  // ============================================================================
  // Portal
  // ============================================================================
  // Low-level adapters for interacting with Idaho's form controls. Everything
  // here deals with DOM quirks rather than work-search business rules.
  const Portal = (() => {
    const dispatchFieldEvents = (element) => {
      // Native events help browser validation and portal scripts observe changes.
      element.dispatchEvent(new Event("input", { bubbles: true }));
      element.dispatchEvent(new Event("change", { bubbles: true }));

      // Idaho's portal currently uses jQuery validation/toggle code in places.
      if (window.jQuery) {
        window.jQuery(element).trigger("change");
      }
    };

    const setSelectByText = (select, text) => {
      // Chosen hides the real select, so update both the value and Chosen display.
      const normalizedText = text.toLowerCase();
      const option = Array.from(select.options).find((optionItem) => {
        // Select by visible text because CSV values store names, not option ids.
        return optionItem.textContent?.trim().toLowerCase() === normalizedText;
      });
      if (!option) return false;

      select.value = option.value;
      dispatchFieldEvents(select);
      if (window.jQuery) {
        window.jQuery(select).trigger("chosen:updated");
      }
      return true;
    };

    const getRadioGroupCurrentLabel = (expectedInput) => {
      // Report the visible radio label so mismatch messages are useful.
      const checkedInput = document.querySelector(
        `input[type="radio"][name="${expectedInput.name}"]:checked`,
      );
      if (!(checkedInput instanceof HTMLInputElement))
        return "nothing selected";

      const checkedLabel = document.querySelector(
        `label[for="${checkedInput.id}"]`,
      );
      return (
        checkedLabel?.textContent?.trim() || checkedInput.value || "selected"
      );
    };

    const getFormFieldValue = (element) => {
      // Selects should be reported by visible option text in the review panel.
      if (element instanceof HTMLSelectElement) {
        return element.selectedOptions[0]?.textContent?.trim() || "";
      }

      return element.value.trim();
    };

    const setInputValue = (field, row) => {
      // Fill a single portal field from the selected CSV row.
      const element = document.querySelector(field.selector);
      const rawValue = field.value(row);
      const value = Format.truncate(rawValue, field.maxLength || 10_000);

      if (
        !(element instanceof HTMLInputElement) &&
        !(element instanceof HTMLTextAreaElement) &&
        !(element instanceof HTMLSelectElement)
      ) {
        return {
          kind: "error",
          ok: false,
          message: `${field.label}: field not found (${field.selector})`,
        };
      }

      if (!value && field.required) {
        // Required CSV data is missing before we even touch the portal field.
        return {
          kind: "error",
          ok: false,
          message: `${field.label}: missing required CSV value`,
        };
      }

      if (!value) {
        // Optional blanks intentionally clear optional fields for consistency.
        element.value = "";
        dispatchFieldEvents(element);
        return {
          kind: "info",
          ok: true,
          message: `${field.label}: left blank`,
        };
      }

      if (field.radio && element instanceof HTMLInputElement) {
        // Radios are clicked so any portal show/hide behavior fires naturally.
        element.click();
        dispatchFieldEvents(element);
        return {
          kind: element.checked ? "success" : "error",
          ok: element.checked,
          message: `${field.label}: ${value}`,
        };
      }

      if (element instanceof HTMLSelectElement && field.selectText) {
        // State and country dropdowns are selected by label text.
        const found = setSelectByText(element, value);
        return {
          kind: found ? "success" : "error",
          ok: found,
          message: found
            ? `${field.label}: ${value}`
            : `${field.label}: option not found for ${value}`,
        };
      }

      element.value = value;
      dispatchFieldEvents(element);
      return {
        kind: "success",
        ok: true,
        message: `${field.label}: ${value}`,
      };
    };

    const selectRadio = (answer) => {
      // Use clicks for radios so portal-owned validation and toggle handlers run.
      const input = document.querySelector(answer.selector);
      if (!(input instanceof HTMLInputElement)) {
        return {
          kind: "error",
          ok: false,
          message: `${answer.label}: field not found (${answer.selector})`,
        };
      }

      if (!input.checked) input.click();
      dispatchFieldEvents(input);

      return {
        kind: input.checked ? "success" : "error",
        ok: input.checked,
        message: input.checked
          ? `${answer.label}: ${answer.normalAnswer}`
          : `${answer.label}: expected ${answer.normalAnswer}`,
      };
    };

    const selectCheckbox = (acknowledgement) => {
      // Final acknowledgements are checked only after an explicit helper click.
      const input = document.querySelector(acknowledgement.selector);
      if (!(input instanceof HTMLInputElement)) {
        return {
          kind: "error",
          ok: false,
          message: `${acknowledgement.label}: field not found (${acknowledgement.selector})`,
        };
      }

      if (!input.checked) input.click();
      dispatchFieldEvents(input);

      return {
        kind: input.checked ? "success" : "error",
        ok: input.checked,
        message: input.checked
          ? `${acknowledgement.label}: checked`
          : `${acknowledgement.label}: not checked`,
      };
    };

    return {
      dispatchFieldEvents,
      getFormFieldValue,
      getRadioGroupCurrentLabel,
      selectCheckbox,
      selectRadio,
      setInputValue,
    };
  })();

  // ============================================================================
  // WorkSearch
  // ============================================================================
  // Connects generated CSV rows to the Step 3 add-action form. It fills from
  // CSV rows, but all review/check behavior reads the actual form state.
  const WorkSearch = (() => {
    const getContactName = (row) => {
      // Prefer a generic contact only when the source clearly names a hiring team.
      const sender = Format.cellValue(row, "source_sender");
      if (sender.toLowerCase().includes("hiring team")) return "Hiring Team";
      return "";
    };

    const getNextStepText = (row) => {
      // Keep the next-step text short and generic for application submissions.
      const company = Format.cellValue(row, "company") || "the employer";
      return Format.truncate(`Awaiting response from ${company}.`, 200);
    };

    // Declarative mapping from CSV columns to the Idaho work-search form fields.
    // Adding another portal field should usually be a new object in this array.
    const fields = [
      {
        label: "Action Date",
        required: true,
        selector: "#ContactDate",
        value: (row) =>
          Format.toPortalDate(Format.cellValue(row, "action_date")),
      },
      {
        label: "Contact Name",
        selector: "#ContactName",
        value: getContactName,
      },
      {
        label: "Contact Phone",
        selector: "#ContactPhone",
        value: (row) =>
          Format.findPhone(Format.cellValue(row, "employer_contact")),
      },
      {
        label: "Company Name",
        maxLength: 50,
        required: true,
        selector: "#CompanyName",
        value: (row) => Format.cellValue(row, "company"),
      },
      {
        label: "Company Address",
        maxLength: 60,
        required: true,
        selector: "#CompanyAddressStreet",
        value: (row) => Format.cellValue(row, "mailing_address_line_1"),
      },
      {
        label: "Address Line 2",
        maxLength: 60,
        selector: "#CompanyAddressStreet2",
        value: (row) => Format.cellValue(row, "mailing_address_line_2"),
      },
      {
        label: "Country",
        required: true,
        selector: "#CompanyCountryID",
        selectText: true,
        value: () => "United States of America",
      },
      {
        label: "City",
        maxLength: 30,
        required: true,
        selector: "#CompanyAddressCity",
        value: (row) => Format.cellValue(row, "city"),
      },
      {
        label: "State",
        required: true,
        selector: "#SelectedStateID",
        selectText: true,
        value: Format.getStateName,
      },
      {
        label: "ZIP Code",
        maxLength: 6,
        required: true,
        selector: "#CompanyAddressZipcode",
        value: Format.getZipCode,
      },
      {
        label: "Company Website",
        maxLength: 60,
        required: true,
        selector: "#CompanyWebsite",
        value: (row) => Format.cellValue(row, "employer_website"),
      },
      {
        label: "Company Email",
        maxLength: 60,
        selector: "#CompanyEmail",
        value: (row) => {
          // Prefer enriched employer contact, then fall back to source sender.
          return (
            Format.findEmail(Format.cellValue(row, "employer_contact")) ||
            Format.findEmail(Format.cellValue(row, "source_sender")) ||
            ""
          );
        },
      },
      {
        label: "Type of Work or Job Title",
        maxLength: 60,
        required: true,
        selector: "#TypeOfWork",
        value: (row) => Format.cellValue(row, "job_title"),
      },
      {
        label: "Application Submitted",
        radio: true,
        selector: "#RdoSubmittedTrue",
        value: () => "Yes",
      },
      {
        label: "Additional Information",
        maxLength: 200,
        required: true,
        selector: "#NextStep",
        value: getNextStepText,
      },
    ];

    const getFormSelections = () => {
      // Validate the live portal form, not the selected source CSV row.
      return fields.map((field) => {
        const element = document.querySelector(field.selector);
        if (
          !(element instanceof HTMLInputElement) &&
          !(element instanceof HTMLTextAreaElement) &&
          !(element instanceof HTMLSelectElement)
        ) {
          return {
            kind: "error",
            message: `${field.label}: field not found (${field.selector})`,
          };
        }

        if (field.radio && element instanceof HTMLInputElement) {
          // For radios, the expected input is the one represented by the field.
          const currentAnswer = Portal.getRadioGroupCurrentLabel(element);
          return {
            kind: element.checked ? "success" : "error",
            message: element.checked
              ? `${field.label}: ${field.value({})}`
              : `${field.label}: expected ${field.value({})}, currently ${currentAnswer}`,
          };
        }

        const value = Portal.getFormFieldValue(element);
        if (field.required && !String(value || "").trim()) {
          // Required form blanks are what should stop the user before saving.
          return {
            kind: "error",
            message: `${field.label}: missing required form value`,
          };
        }

        return {
          kind: value ? "success" : "info",
          message: value
            ? `${field.label}: ${Format.truncate(value, 200)}`
            : `${field.label}: blank optional field`,
        };
      });
    };

    const fillForm = (panel) => {
      // Fill the current add-action form, then leave Save Action to the user.
      const row = CsvStore.getSelectedRow(panel);
      if (!row) {
        Status.set(panel, ["Import the CSV and choose a row first."], "error");
        return;
      }

      const results = fields.map((field) => Portal.setInputValue(field, row));
      const errors = results.filter((result) => !result.ok);
      // Show every field result so the user can review what was filled.
      Status.set(
        panel,
        [
          errors.length > 0
            ? "Some fields need review before saving."
            : "Filled selected work-search row. Review, then save manually.",
          ...results,
        ],
        errors.length > 0 ? "error" : "success",
      );
    };

    const refreshCsvControls = (panel) => {
      // Rebuild row options from the locally stored CSV and current claim week.
      const rows = CsvStore.getRowsForCurrentWeek();
      const count = panel.querySelector("[data-wsr-csv-count]");
      const select = panel.querySelector("[data-wsr-csv-row]");

      if (count) {
        const suffix = rows.length === 1 ? "row" : "rows";
        count.textContent = `${rows.length} current-week CSV ${suffix} loaded.`;
      }

      if (!(select instanceof HTMLSelectElement)) return;

      select.replaceChildren();
      for (const [index, row] of rows.entries()) {
        // Option values are stable for the current filtered row list only.
        const option = document.createElement("option");
        option.value = String(index);
        option.textContent = CsvStore.summarizeRow(row);
        select.append(option);
      }

      select.disabled = rows.length === 0;
      if (rows.length > 0) select.value = "0";
    };

    const importCsvFile = (panel, file) => {
      // Rebuild controls after import so the newly loaded rows appear instantly.
      CsvStore.importFile(panel, file, () => refreshCsvControls(panel));
    };

    const noteSelectedCsvRow = (panel) => {
      // Selecting a CSV row is not a form check; it only confirms the source row.
      const row = CsvStore.getSelectedRow(panel);
      if (row) {
        Status.set(panel, [`Selected CSV row: ${CsvStore.summarizeRow(row)}`]);
      }
    };

    return {
      fillForm,
      getFormSelections,
      importCsvFile,
      noteSelectedCsvRow,
      refreshCsvControls,
    };
  })();

  // ============================================================================
  // Acknowledgements
  // ============================================================================
  // Final certification checkboxes live in their own module because this is the
  // closest the helper gets to the final submit boundary.
  const Acknowledgements = (() => {
    const getSelections = (acknowledgements) => {
      // Read the submitted-form state for each legal acknowledgement checkbox.
      return acknowledgements.map((acknowledgement) => {
        const input = document.querySelector(acknowledgement.selector);

        if (!(input instanceof HTMLInputElement)) {
          return {
            kind: "error",
            message: `${acknowledgement.label}: field not found (${acknowledgement.selector})`,
          };
        }

        return {
          kind: input.checked ? "success" : "error",
          message: input.checked
            ? `${acknowledgement.label}: checked`
            : `${acknowledgement.label}: not checked`,
        };
      });
    };

    const fill = (panel, config) => {
      // Mark acknowledgements, but never submit the certification application.
      const results = config.acknowledgements.map(Portal.selectCheckbox);
      const errors = results.filter((result) => !result.ok);

      Status.set(
        panel,
        [
          errors.length > 0
            ? "Some acknowledgements were not checked."
            : "Checked acknowledgements. Review all statements, then submit manually.",
          ...results,
        ],
        errors.length > 0 ? "error" : "success",
      );
    };

    return { fill, getSelections };
  })();

  // ============================================================================
  // SimpleAnswers
  // ============================================================================
  // Handles pages where the helper only sets a fixed list of radio answers.
  // Current examples are Work Availability and Income.
  const SimpleAnswers = (() => {
    const getSelections = (answers) => {
      // Used by Step 1 and Step 2 to compare expected answers to form state.
      return answers.map((answer) => {
        const input = document.querySelector(answer.selector);

        if (!(input instanceof HTMLInputElement)) {
          return {
            kind: "error",
            message: `${answer.label}: field not found (${answer.selector})`,
          };
        }

        if (input.checked) {
          return {
            kind: "success",
            message: `${answer.label}: ${answer.normalAnswer}`,
          };
        }

        const currentAnswer = Portal.getRadioGroupCurrentLabel(input);
        return {
          kind: "error",
          message: `${answer.label}: expected ${answer.normalAnswer}, currently ${currentAnswer}`,
        };
      });
    };

    const fill = (panel, config) => {
      // Shared radio-answer fill path for Work Availability and Income pages.
      const results = config.answers.map(Portal.selectRadio);
      const missing = results.filter((result) => !result.ok);

      if (missing.length > 0) {
        // Missing selectors mean the page markup changed or the wrong page loaded.
        Status.set(
          panel,
          [
            "Some fields were not found. Do not continue until reviewed.",
            ...missing,
          ],
          "error",
        );
        return;
      }

      Status.set(
        panel,
        [
          "Filled normal answers. Review the page, then click Next manually.",
          ...results,
        ],
        "success",
      );
    };

    return { fill, getSelections };
  })();

  // ============================================================================
  // Pages
  // ============================================================================
  // Detects which certification page is currently open and returns the config
  // Panel needs to render the right controls.
  const Pages = (() => {
    // Route-specific config keeps page detection and button behavior together.
    const configs = [
      {
        // Step 1 and Step 2 identify by exact save-form actions when present.
        id: "work-availability",
        title: "Step 1 - Work Availability",
        actionLabel: "Fill normal work availability answers",
        formAction:
          "/ClaimantPortal/CertificationApplication/SaveWorkAvailability",
        pathIncludes:
          "/ClaimantPortal/CertificationApplication/WorkAvailability",
        answers: Config.workAvailabilityAnswers,
      },
      {
        id: "income",
        title: "Step 2 - Income",
        actionLabel: "Fill normal income answers",
        formAction: "/ClaimantPortal/CertificationApplication/SaveIncome",
        pathIncludes: "/ClaimantPortal/CertificationApplication/Income",
        answers: Config.incomeAnswers,
      },
      {
        // Work-search list has no fill action; it is mainly the CSV import page.
        id: "work-search-list",
        title: "Step 3 - Work Search Actions",
        pathIncludes:
          "/ClaimantPortal/CertificationApplication/WorkSearchContacts",
        type: "work-search-list",
      },
      {
        // The add-action form uses a contact type query string in the action URL,
        // so route detection matches the stable form-action prefix.
        id: "work-search-form",
        title: "Step 3 - Add Work Search Action",
        actionLabel: "Fill selected CSV work-search row",
        formActionPrefix:
          "/ClaimantPortal/CertificationApplication/SaveWorkSearchContact",
        pathIncludes:
          "/ClaimantPortal/CertificationApplication/AddWorkSearchContact",
        type: "work-search-form",
      },
      {
        // Submit-page acknowledgements are checked, never submitted.
        id: "submit",
        title: "Submit - Certification Acknowledgements",
        actionLabel: "Mark acknowledgements as agreed",
        acknowledgements: Config.certificationAcknowledgements,
        formActionPrefix: "/ClaimantPortal/CertificationApplication/SaveSubmit",
        pathIncludes: "/ClaimantPortal/CertificationApplication/Submit",
        type: "submit-acknowledgements",
      },
    ];

    const findCurrent = () => {
      // Match by URL path and, where possible, by the form action in pasted HTML.
      return configs.find((config) => {
        const form = config.formAction
          ? document.querySelector(`form[action="${config.formAction}"]`)
          : undefined;
        const prefixedForm = config.formActionPrefix
          ? document.querySelector(`form[action^="${config.formActionPrefix}"]`)
          : undefined;

        // Use the path first for normal navigation, with form action as backup.
        return (
          location.pathname.includes(config.pathIncludes) ||
          Boolean(form) ||
          Boolean(prefixedForm)
        );
      });
    };

    return { findCurrent };
  })();

  // ============================================================================
  // Panel
  // ============================================================================
  // Builds the right-side drawer, page-specific controls, and event wiring.
  const Panel = (() => {
    const injectStyles = () => {
      // Userscript CSS is scoped under panelId to avoid changing portal styles.
      const style = document.createElement("style");
      style.textContent = `
        #${Config.panelId} {
          position: fixed;
          top: 0;
          right: 0;
          bottom: 0;
          z-index: 2147483647;
          width: min(430px, calc(100vw - 48px));
          background: #ffffff;
          color: #1f2933;
          box-shadow: -12px 0 30px rgba(15, 23, 42, 0.22);
          font: 14px/1.4 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          transform: translateX(100%);
          transition: transform 160ms ease;
        }

        #${Config.panelId}.is-open {
          transform: translateX(0);
        }

        #${Config.panelId} .wsr-tab {
          position: absolute;
          top: 140px;
          left: -44px;
          width: 44px;
          min-height: 96px;
          padding: 10px 0;
          border: 1px solid #9eb3c7;
          border-right: 0;
          border-radius: 6px 0 0 6px;
          background: #14558f;
          color: #ffffff;
          cursor: pointer;
          font-weight: 800;
          letter-spacing: 0;
          writing-mode: vertical-rl;
        }

        #${Config.panelId} .wsr-panel-body {
          height: 100%;
          box-sizing: border-box;
          padding: 18px;
          overflow: auto;
          border-left: 1px solid #9eb3c7;
        }

        #${Config.panelId} .wsr-panel-header {
          display: grid;
          grid-template-columns: 1fr auto;
          gap: 10px;
          align-items: start;
        }

        #${Config.panelId} .wsr-close {
          width: auto;
          margin: 0;
          padding: 5px 8px;
          background: #e8eef5;
          color: #17324d;
        }

        #${Config.panelId} h2 {
          margin: 0 0 8px;
          font-size: 16px;
          line-height: 1.2;
        }

        #${Config.panelId} p {
          margin: 8px 0;
        }

        #${Config.panelId} button {
          width: 100%;
          margin: 8px 0 0;
          padding: 8px 10px;
          border: 0;
          border-radius: 4px;
          background: #14558f;
          color: #ffffff;
          cursor: pointer;
          font-weight: 700;
        }

        #${Config.panelId} button.secondary {
          background: #e8eef5;
          color: #17324d;
        }

        #${Config.panelId} label.wsr-label {
          display: block;
          margin: 10px 0 4px;
          font-weight: 700;
        }

        #${Config.panelId} input[type="file"],
        #${Config.panelId} select {
          width: 100%;
          box-sizing: border-box;
        }

        #${Config.panelId} select {
          min-height: 34px;
        }

        #${Config.panelId} .wsr-muted {
          color: #52606d;
          font-size: 12px;
        }

        #${Config.panelId} .wsr-status {
          margin: 10px 0 0;
          color: #1f2933;
        }

        #${Config.panelId} .wsr-status-row {
          display: grid;
          grid-template-columns: 30px 1fr;
          gap: 8px;
          margin: 6px 0 0;
          padding: 8px;
          border-left: 4px solid #9eb3c7;
          border-radius: 4px;
          background: #f5f7fa;
        }

        #${Config.panelId} .wsr-status-marker {
          font-weight: 800;
        }

        #${Config.panelId} .wsr-status-row.is-success {
          border-left-color: #16833a;
          background: #eefaf1;
          color: #0f5f2a;
        }

        #${Config.panelId} .wsr-status-row.is-error {
          border-left-color: #c92a2a;
          background: #fff1f1;
          color: #8a1c1c;
          font-weight: 700;
        }
      `;
      document.head.append(style);
    };

    const getIsOpen = () => {
      // Default open so the helper is visible when first installed.
      return localStorage.getItem(Config.panelOpenStorageKey) !== "false";
    };

    const setIsOpen = (panel, isOpen) => {
      // Remember drawer state so page-to-page navigation does not feel jumpy.
      panel.classList.toggle("is-open", isOpen);
      localStorage.setItem(Config.panelOpenStorageKey, String(isOpen));

      const tab = panel.querySelector("[data-wsr-toggle]");
      if (tab instanceof HTMLButtonElement) {
        tab.setAttribute("aria-expanded", String(isOpen));
        tab.setAttribute(
          "aria-label",
          isOpen ? "Hide Work Search Reporter" : "Show Work Search Reporter",
        );
      }
    };

    const getCheckButtonLabel = (config) => {
      // Button copy should name what is being checked on the live page.
      if (config?.type === "work-search-form") return "Check form fields";
      if (config?.type === "work-search-list") return "Refresh CSV rows";
      if (config?.type === "submit-acknowledgements") {
        return "Review acknowledgement status";
      }
      return "Check current selections";
    };

    const getControls = (config) => {
      // Render only the controls relevant to the detected certification page.
      if (!config) {
        return `
          <button type="button" data-wsr-fill disabled>
            No fill action available
          </button>
        `;
      }

      if (config.type === "work-search-list") {
        // Import on the list page lets the user load CSV rows before adding.
        return `
          <label class="wsr-label" for="wsr-csv-file">CSV file</label>
          <input id="wsr-csv-file" type="file" accept=".csv,text/csv" data-wsr-csv-file>
          <p class="wsr-muted" data-wsr-csv-count></p>
        `;
      }

      if (config.type === "work-search-form") {
        // The add-action form needs both source selection and fill controls.
        return `
          <label class="wsr-label" for="wsr-csv-file">CSV file</label>
          <input id="wsr-csv-file" type="file" accept=".csv,text/csv" data-wsr-csv-file>
          <p class="wsr-muted" data-wsr-csv-count></p>
          <label class="wsr-label" for="wsr-csv-row">CSV row</label>
          <select id="wsr-csv-row" data-wsr-csv-row></select>
          <button type="button" data-wsr-fill>
            ${config.actionLabel}
          </button>
        `;
      }

      return `
        <button type="button" data-wsr-fill>
          ${config.actionLabel}
        </button>
      `;
    };

    const handleCheckButton = (panel, config) => {
      // All check actions inspect live page state, not just source data.
      if (!config) return;

      if (config.answers) {
        // Step 1 and Step 2 check expected radio answers against the form.
        Status.set(panel, SimpleAnswers.getSelections(config.answers));
        return;
      }

      if (config.acknowledgements) {
        // Submit page checks legal acknowledgement boxes only.
        Status.set(
          panel,
          Acknowledgements.getSelections(config.acknowledgements),
        );
        return;
      }

      if (config.type === "work-search-form") {
        // Work-search review must always inspect the live form fields.
        Status.set(panel, WorkSearch.getFormSelections());
        return;
      }

      if (config.type === "work-search-list") {
        // The list page has no fields to validate, so refresh CSV counts.
        WorkSearch.refreshCsvControls(panel);
        Status.set(panel, [
          "CSV rows refreshed. Choose Add Work Search Action in the portal, then select Completed and submitted application to employer.",
        ]);
      }
    };

    const bindEvents = (panel, config) => {
      // Keep all event binding in one place after the drawer HTML is rendered.
      const toggleButton = panel.querySelector("[data-wsr-toggle]");
      toggleButton?.addEventListener("click", () => {
        setIsOpen(panel, !panel.classList.contains("is-open"));
      });

      const closeButton = panel.querySelector("[data-wsr-close]");
      closeButton?.addEventListener("click", () => {
        setIsOpen(panel, false);
      });

      const fillButton = panel.querySelector("[data-wsr-fill]");
      fillButton?.addEventListener("click", () => {
        // Dispatch to the module that owns the detected page behavior.
        if (config?.answers) SimpleAnswers.fill(panel, config);
        if (config?.acknowledgements) Acknowledgements.fill(panel, config);
        if (config?.type === "work-search-form") WorkSearch.fillForm(panel);
      });

      const csvFile = panel.querySelector("[data-wsr-csv-file]");
      csvFile?.addEventListener("change", (event) => {
        // User-selected files are only readable after this change event.
        const input = event.target;
        if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return;
        WorkSearch.importCsvFile(panel, input.files[0]);
      });

      const csvRow = panel.querySelector("[data-wsr-csv-row]");
      csvRow?.addEventListener("change", () => {
        WorkSearch.noteSelectedCsvRow(panel);
      });

      const checkButton = panel.querySelector("[data-wsr-check]");
      checkButton?.addEventListener("click", () => {
        handleCheckButton(panel, config);
      });
    };

    const render = (config) => {
      // Build the right-side drawer and wire all page-specific actions.
      if (document.getElementById(Config.panelId)) return;

      injectStyles();

      const panel = document.createElement("aside");
      panel.id = Config.panelId;
      panel.innerHTML = `
        <button type="button" class="wsr-tab" data-wsr-toggle>
          WSR
        </button>
        <div class="wsr-panel-body">
          <div class="wsr-panel-header">
            <h2>Work Search Reporter</h2>
            <button type="button" class="wsr-close" data-wsr-close>
              Hide
            </button>
          </div>
          <p><strong>${config ? config.title : "No helper for this page yet"}</strong></p>
          <p>This helper fills fields only. It never clicks Next or Submit.</p>
          ${getControls(config)}
          <button type="button" class="secondary" data-wsr-check ${config ? "" : "disabled"}>
            ${getCheckButtonLabel(config)}
          </button>
          <div class="wsr-status" data-wsr-status></div>
        </div>
      `;

      document.body.append(panel);
      setIsOpen(panel, getIsOpen());
      Status.set(panel, [
        config
          ? "Ready. Review before and after filling."
          : "Send the screenshot and form HTML for this page to add it.",
      ]);

      bindEvents(panel, config);

      if (config?.type?.startsWith("work-search")) {
        // Populate controls from any previously imported CSV rows.
        WorkSearch.refreshCsvControls(panel);
      }
    };

    return { render };
  })();

  // ============================================================================
  // App
  // ============================================================================
  // Tiny bootstrap: detect the page and render the helper.
  const App = (() => {
    const start = () => {
      Panel.render(Pages.findCurrent());
    };

    return { start };
  })();

  App.start();
})();

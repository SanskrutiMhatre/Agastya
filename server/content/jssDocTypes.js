'use strict';
/*
  The 13 real JSS0251 document types (jss-stencils/JSS0251-stencils/*.docx),
  extracted directly from those stencils: everything about a JSS book's page
  size, margins, fonts and running head/foot is already identical across
  every type and already how vendor/pipeline/jsstofo renders a book; the one
  thing that genuinely varies per type is this short set of strings - the
  cover page's title block (sometimes more than one line) and the shorter
  phrase the running head carries beside the system name.

  `lines` becomes the cover's <documentType> front-matter override
  (project.json frontMatter.titlePage(Joint).documentType, deep-merged over
  the house default - the one mechanism already in the pipeline for this).
  `header` becomes <bookmeta><documentTypeHeader>, read by the running head
  in place of the free-text book name whenever it is set (jsstofo.xsl
  $book.name falls back to bookName when it is not, so an existing project
  with no document type chosen keeps rendering exactly as before).
*/
const DOCUMENT_TYPES = {
  UHB: { label: 'User Handbook (UHB)', lines: ['USER HANDBOOK'], header: 'User Handbook' },
  MM: { label: 'Maintenance Manual (MM)', lines: ['TECHNICAL MANUAL', 'PART II MAINTENANCE'], header: 'Maintenance' },
  ORM: { label: 'Overhaul and Reconditioning Manual (ORM)', lines: ['TECHNICAL MANUAL', 'PART III OVERHAUL AND RECONDITIONING'], header: 'Overhaul and Reconditioning' },
  TM_PI: { label: 'Technical Manual - Technical Information (TM_PI)', lines: ['TECHNICAL MANUAL', 'PART I TECHNICAL INFORMATION'], header: 'Technical Information' },
  DS: { label: 'Design Specification (DS)', lines: ['DESIGN SPECIFICATION'], header: 'Design Specification' },
  MRLS: { label: "Manufacturer's Recommended List of Spares (MRLS)", lines: ["MANUFACTURER'S RECOMMENDED LIST OF SPARES (MRLS)"], header: 'MRLS' },
  PRS: { label: 'Permissive Repair Schedule (PRS)', lines: ['PERMISSIVE REPAIR SCHEDULE'], header: 'Permissive Repair Schedule' },
  ROTABLE: { label: 'Rotable List (ROTABLE)', lines: ['ROTABLE LIST, NORMS OF CONSUMPTION, MANDATORY / NON-MANDATORY SPARES LIST FOR EACH SYSTEM'], header: 'Rotable List' },
  TOTE_AND_CS: { label: 'Tools, Equipment and Carried Spares (TOTE_and_CS)', lines: ['TABLE OF TOOLS AND EQUIPMENT AND CARRIED SPARES'], header: 'Table of Tools and Equipment and Carried Spares' },
  ISPL: { label: 'Illustrative Spares Part List (ISPL)', lines: ['ILLUSTRATIVE SPARES PART LIST (ISPL)'], header: 'ISPL' },
  MPL: { label: "Manufacturer's Part List", lines: ['TECHNICAL MANUAL', "MANUFACTURER'S PARTS LIST"], header: "Manufacturer's Parts List" },
  VOL1_PL: { label: 'Parts List, Vol 1 (Vol_1_PL)', lines: ['TECHNICAL MANUAL', 'PART / VOLUME IV / 1', "MANUFACTURER'S PARTS LIST", 'PARTS LIST'], header: 'Parts List' },
  VOL2_ILL: { label: 'Illustrations, Vol 2 (Vol_2_Illustrations)', lines: ['TECHNICAL MANUAL', 'PART / VOLUME IV / 2', "MANUFACTURER'S PARTS LIST", 'ILLUSTRATIONS'], header: 'Illustrations' },
};
const DEFAULT_DOCUMENT_TYPE = 'UHB';

module.exports = { DOCUMENT_TYPES, DEFAULT_DOCUMENT_TYPE };

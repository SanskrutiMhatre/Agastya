<?xml version="1.0" encoding="UTF-8"?>
<!-- ********************************************************************
     JSS to XSL-FO Transformation Stylesheet

     Main entry point for the JSS (Joint Services Specification) User
     Handbook / Operator's Manual publishing pipeline. Structured to
     reproduce the layout defined in Stencil/Stencil.pdf.

     This pipeline is fully independent of s1000dtofo/. The S1000D
     stylesheets are not included here and are unaffected by changes made
     in this directory.
     ******************************************************************** -->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"
  xmlns:fo="http://www.w3.org/1999/XSL/Format">

    <xsl:output method="xml" indent="no" encoding="UTF-8"/>
    <xsl:strip-space elements="jssbook bookmeta frontmatter body chapter section publishers publisher
                               recordOfChanges associatedHandbooks listOfAbbreviations descriptionOfSymbols
                               changeNotice firstAid cautionsNotes demolition proprietary foreword
                               symbolList symbol noticeList table thead tbody row list item"/>

    <!-- ==================================================================== -->
    <!--                         PAGE PARAMETERS                               -->
    <!-- ==================================================================== -->
    <xsl:param name="page-width">210mm</xsl:param>
    <xsl:param name="page-height">297mm</xsl:param>
    <xsl:param name="page-margin-top">12mm</xsl:param>
    <xsl:param name="page-margin-bottom">12mm</xsl:param>
    <!-- Binding edge gets the wider margin; mirrored on odd/even pages -->
    <xsl:param name="margin-inner">25mm</xsl:param>
    <xsl:param name="margin-outer">18mm</xsl:param>
    <xsl:param name="body-margin-top">14mm</xsl:param>
    <xsl:param name="body-margin-bottom">14mm</xsl:param>
    <xsl:param name="region-before-extent">14mm</xsl:param>
    <xsl:param name="region-after-extent">14mm</xsl:param>

    <!-- ==================================================================== -->
    <!--                         TYPOGRAPHY PARAMETERS                         -->
    <!-- ==================================================================== -->
    <xsl:param name="font-family">Helvetica</xsl:param>
    <!--
      Fonts consulted for any character the main font does not contain.

      The base-14 PDF fonts are WinAnsi-encoded and have no glyph for
      characters as ordinary in a technical manual as U+2265 GREATER-THAN OR
      EQUAL TO. FOP does not fail on a missing glyph — it prints "#" and logs a
      warning nobody reads, so "≥ 40 mm" silently became "# 40 mm".

      FOP resolves a comma-separated font-family per CHARACTER, so naming the
      base-14 Symbol and ZapfDingbats after the main font fills the gaps with
      no font files to ship. Text the main font can render is unaffected: it is
      still tried first. Mirrors s1000dtofo's font.fallback so both engines
      render the same characters.
    -->
    <!--
      DejaVu Sans comes first: it is a bundled Unicode font (registered in
      tools/fop.xconf) and covers the Latin Extended-B, punctuation and symbol
      ranges the base-14 fonts and Symbol both lack, e.g. U+01A5 LATIN SMALL
      LETTER P WITH HOOK, which used to print as "#". Symbol and ZapfDingbats
      stay after it as a last resort for the few dingbats DejaVu lacks.
    -->
    <xsl:param name="font.fallback">DejaVu Sans,Symbol,ZapfDingbats</xsl:param>
    <xsl:variable name="font-stack">
        <xsl:value-of select="$font-family"/>
        <xsl:if test="normalize-space($font.fallback) != ''">
            <xsl:value-of select="concat(',', $font.fallback)"/>
        </xsl:if>
    </xsl:variable>
    <xsl:param name="font-size">11pt</xsl:param>
    <xsl:param name="line-height">1.35</xsl:param>
    <xsl:param name="heading1-size">16pt</xsl:param>
    <xsl:param name="heading2-size">12pt</xsl:param>
    <xsl:param name="heading3-size">11pt</xsl:param>
    <xsl:param name="header-footer-size">9pt</xsl:param>
    <!--
      The cover/title page's own headline typography (documentType, "FOR",
      the system name) — the largest, most prominent text in the whole book,
      and until now the one piece of it Settings could not touch at all: a
      literal font-size="15pt" at each point of use in frontmatter.xsl, no
      font-family override, so a house wanting a different look for its cover
      than its body text had no lever to pull. Family defaults to the body's
      own font-stack, so an unset project renders exactly as before.
    -->
    <xsl:param name="cover.title.font-family" select="$font-stack"/>
    <xsl:param name="cover.title.font-size">14pt</xsl:param>
    <!--
      The security classification banner ("RESTRICTED" and friends).

      Everything about it used to be hardcoded at the point of use, so a
      customer whose house style wants it black, larger, or sitting further
      from the text had no way to say so. Each value below defaults to what the
      engine already produced, so an unset project renders byte-identically to
      before and only a deliberate change moves anything.

      Padding rather than margin: the direct engine draws the banner inside a
      header/footer table cell, where padding is the lever that actually moves
      it. The same properties then mean the same thing on both engines.
    -->
    <xsl:param name="classification.size"/>            <!-- empty = follow header-footer-size -->
    <xsl:param name="classification.color">#CC0000</xsl:param>
    <xsl:param name="classification.weight">bold</xsl:param>
    <xsl:param name="classification.decoration">underline</xsl:param>
    <xsl:param name="classification.align">center</xsl:param>
    <xsl:param name="classification.padding.top">0pt</xsl:param>
    <xsl:param name="classification.padding.bottom">0pt</xsl:param>
    <xsl:param name="classification.padding.left">0pt</xsl:param>
    <xsl:param name="classification.padding.right">0pt</xsl:param>


    <!-- First-aid page artwork. The stencil carries a default src; these let a
         project point at its own illustration and control how much of the page
         it takes, without editing the stencil. -->
    <!-- Per-page heading overrides from Settings; empty = use the stencil wording. -->
    <xsl:param name="fm.title.recordOfChanges"/>
    <xsl:param name="fm.title.associatedHandbooks"/>
    <xsl:param name="fm.title.firstAid"/>
    <xsl:param name="fm.title.changeNotice"/>
    <xsl:param name="fm.title.listOfAbbreviations"/>
    <xsl:param name="fm.title.descriptionOfSymbols"/>
    <xsl:param name="fm.title.foreword"/>
    <xsl:param name="fm.title.demolition"/>
    <xsl:param name="fm.title.listOfContents"/>
    <xsl:param name="fm.title.listOfFigures"/>
    <xsl:param name="fm.title.listOfTables"/>
    <!--
      Overrides for the fixed wording inside the front-matter pages —
      column headings, captions, the run-in sentences. Empty means "use
      the stencil wording", so a project that sets none is unchanged.
    -->
    <xsl:param name="fm.label.abbrev.colMeaning"/>
    <xsl:param name="fm.label.abbrev.colTerm"/>
    <xsl:param name="fm.label.cautions.heading"/>
    <xsl:param name="fm.label.change.colCode"/>
    <xsl:param name="fm.label.change.colNoticeNo"/>
    <xsl:param name="fm.label.change.colPrevious"/>
    <xsl:param name="fm.label.change.colTitle"/>
    <xsl:param name="fm.label.foreword.documentNo"/>
    <xsl:param name="fm.label.handbooks.colInbr"/>
    <xsl:param name="fm.label.handbooks.colSr"/>
    <xsl:param name="fm.label.handbooks.colTitle"/>
    <xsl:param name="fm.label.handbooks.introAfter"/>
    <xsl:param name="fm.label.handbooks.introBefore"/>
    <xsl:param name="fm.label.proprietary.heading"/>
    <xsl:param name="fm.label.roc.colAuthority"/>
    <xsl:param name="fm.label.roc.colChangeNotice"/>
    <xsl:param name="fm.label.roc.colIncorporatedBy"/>
    <xsl:param name="fm.label.roc.colInitials"/>
    <xsl:param name="fm.label.safety.footer"/>
    <xsl:param name="fm.label.safety.heading"/>
    <xsl:param name="fm.label.title.blankPage"/>
    <xsl:param name="fm.label.title.for"/>
    <xsl:param name="fm.label.title.inbrNo"/>
    <xsl:param name="fm.label.title.publishedBy"/>
    <!-- Agastya: the authority block on both title pages (was fixed text). -->
    <xsl:param name="fm.label.title.authorityHeading"/>
    <xsl:param name="fm.label.title.authority"/>
    <xsl:param name="fm.label.titleJoint.contractNo"/>
    <xsl:param name="fm.label.titleJoint.nsn"/>
    <xsl:param name="fm.label.titleJoint.publicationNo"/>
    <xsl:param name="fm.label.titleJoint.publishedBy"/>

    <xsl:param name="firstaid.image"/>
    <xsl:param name="firstaid.image.width">58mm</xsl:param>
    <xsl:param name="firstaid.image.height">215mm</xsl:param>
    <xsl:param name="table-font-size">10pt</xsl:param>

    <!--
      Per-level body-section headings (levels 1-4). Each level has its own font
      size, space above/below, left indent of the heading, left indent of the
      content under it, and whether the title is upper-cased. Sizes default from
      heading2/3-size so existing output is unchanged; the settings UI drives
      all of these. Levels deeper than 4 reuse level 4.
    -->
    <!-- pageBreakBefore is off by default at every level: sections normally
         flow continuously to save paper. Level 1 is the natural one to turn
         on, since each Data Module in a chapter is its own level-1 section —
         switching it on starts every DM on a fresh page. -->
    <xsl:param name="heading.1.size" select="$heading2-size"/>
    <xsl:param name="heading.1.spaceBefore">5mm</xsl:param>
    <xsl:param name="heading.1.spaceAfter">2mm</xsl:param>
    <xsl:param name="heading.1.indent">0mm</xsl:param>
    <xsl:param name="heading.1.bodyIndent">6mm</xsl:param>
    <xsl:param name="heading.1.uppercase">1</xsl:param>
    <xsl:param name="heading.1.pageBreakBefore">0</xsl:param>

    <xsl:param name="heading.2.size" select="$heading3-size"/>
    <xsl:param name="heading.2.spaceBefore">5mm</xsl:param>
    <xsl:param name="heading.2.spaceAfter">2mm</xsl:param>
    <xsl:param name="heading.2.indent">6mm</xsl:param>
    <xsl:param name="heading.2.bodyIndent">12mm</xsl:param>
    <xsl:param name="heading.2.uppercase">0</xsl:param>
    <xsl:param name="heading.2.pageBreakBefore">0</xsl:param>

    <xsl:param name="heading.3.size" select="$heading3-size"/>
    <xsl:param name="heading.3.spaceBefore">5mm</xsl:param>
    <xsl:param name="heading.3.spaceAfter">2mm</xsl:param>
    <xsl:param name="heading.3.indent">12mm</xsl:param>
    <xsl:param name="heading.3.bodyIndent">18mm</xsl:param>
    <xsl:param name="heading.3.uppercase">0</xsl:param>
    <xsl:param name="heading.3.pageBreakBefore">0</xsl:param>

    <xsl:param name="heading.4.size" select="$heading3-size"/>
    <xsl:param name="heading.4.spaceBefore">5mm</xsl:param>
    <xsl:param name="heading.4.spaceAfter">2mm</xsl:param>
    <xsl:param name="heading.4.indent">18mm</xsl:param>
    <xsl:param name="heading.4.bodyIndent">24mm</xsl:param>
    <xsl:param name="heading.4.uppercase">0</xsl:param>
    <xsl:param name="heading.4.pageBreakBefore">0</xsl:param>

    <!-- ==================================================================== -->
    <!--                         CONTENT PARAMETERS                            -->
    <!-- ==================================================================== -->
    <!-- Security classification banner printed on cover pages. Overrides the
         value carried in the XML when supplied on the command line. -->
    <xsl:param name="security.classification"/>
    <!-- Watermark SVG file URI (generated by the server from watermark text) -->
    <xsl:param name="watermark.image.uri"/>
    <!-- 'no-repeat' for the one-large-mark styles, 'repeat' for the tiled one -->
    <xsl:param name="watermark.repeat">no-repeat</xsl:param>
    <!-- Release the document is on, e.g. "Release 2". Empty when unreleased,
         which is the case the NOT RELEASED watermark covers. -->
    <xsl:param name="release.label"/>
    <!-- Emit "This page is intentionally left blank." versos between the
         front matter pages, as the stencil does. -->
    <xsl:param name="blank.versos">1</xsl:param>
    <!--
      Path to intentionally-blank.svg, used as a page background in
      pagesetup.xsl. Defaulted to the dev-checkout layout (workDir is
      workspace/projects/<id>, three levels below the repo root), but a
      packaged build's project directory sits somewhere else entirely
      (userData/workspace/projects/<id>) with no fixed number of ".." steps
      back to the app's own files — so the build passes the real relative
      path in as a parameter instead of relying on this default.
    -->
    <xsl:param name="blank.page.svg">../../../server/pipeline/jsstofo/intentionally-blank.svg</xsl:param>

    <!-- How many section levels the List of Contents shows. 1 lists the
         top-level sections of each chapter, as the stencil does; raise it to
         include subsections. -->
    <xsl:param name="toc.section.depth">1</xsl:param>

    <!-- List spacing, all tunable from Settings > Lists. Values are plain mm
         numbers (no unit), so the stylesheet can do the indent arithmetic.
         Gap  = distance from an item's label to its text, PER label style, so a
                single "•" doesn't get the same wide gap a "(viii)" needs.
         Indent = how far a nested list's LABEL sits to the right of its PARENT's
                label. 0 lines a nested label up directly under its parent (so
                "(i)" starts below "(a)"); raise it for a stepped look.
         Item space = vertical gap between items. -->
    <xsl:param name="list.gap.alpha">8</xsl:param>    <!-- (a) (b) (c) -->
    <xsl:param name="list.gap.roman">10</xsl:param>   <!-- (i) (ii) (iii) -->
    <xsl:param name="list.gap.bullet">5</xsl:param>   <!-- bullet / dash -->
    <xsl:param name="list.indent">0</xsl:param>       <!-- mm, nested label vs parent label -->
    <xsl:param name="list.item.space">1.5</xsl:param>

    <!-- Columns for a figure's callout-key legend (number -> part name). -->
    <xsl:param name="figure.legend.cols">2</xsl:param>

    <!--
      Figure sizing caps, per page orientation, in millimetres. A figure's
      requested width/height is honoured up to these; they exist only to stop
      an image running off the physical page. An unsized figure fills the width
      cap and takes its natural height.

      Widths allow a little bleed past the text margins so a "full page" figure
      reaches the page edges; heights sit inside the region so the caption
      always has room (region height less ~10mm for the caption and figure
      spacing):

                       region (WxH mm)     caps (WxH mm)
        portrait A4    167 x 245           167 x 235
        A4 landscape   254 x 158           254 x 148
        A3 landscape   377 x 245           377 x 235

      Widths equal the text width (no bleed past the margin); heights are the
      region depth less ~10mm so the caption always has room.
    -->
    <!-- Default width for a figure with no explicit size, used only in the
         fallback path when the image's pixel size is unknown. -->
    <xsl:param name="graphic.default.width">100%</xsl:param>

    <xsl:param name="graphic.cap.portrait.w">167</xsl:param>
    <xsl:param name="graphic.cap.portrait.h">235</xsl:param>
    <!--
      The system-illustration page's own picture bounds, separate from the
      figure caps: that page is given over to the illustration, so it usually
      wants to be larger than a picture sitting in the text. Defaults to the
      figure caps, so a project that sets neither is unchanged.
    -->
    <xsl:param name="systemimage.max.width"><xsl:value-of select="concat($graphic.cap.portrait.w, 'mm')"/></xsl:param>
    <xsl:param name="systemimage.max.height"><xsl:value-of select="concat($graphic.cap.portrait.h, 'mm')"/></xsl:param>

    <xsl:param name="graphic.cap.landscape.w">254</xsl:param>
    <xsl:param name="graphic.cap.landscape.h">148</xsl:param>
    <xsl:param name="graphic.cap.a3landscape.w">377</xsl:param>
    <xsl:param name="graphic.cap.a3landscape.h">235</xsl:param>

    <!--
      Height of the box that centres "This page is intentionally left blank.".

      It must equal the height of the body region it sits in, so that
      display-align="center" puts the legend on the region's centre line, which
      the symmetric margins place on the centre of the page. Making it any
      larger pushes the legend below centre and overflows the region.

        prelim/body : 297 - 12 - 12 (page margins) - 14 - 14 (header/footer) = 245mm
        cover       : 297 - 12 - 12 (page margins) - 12 - 12 (banners)       = 249mm

      Parameters because XSLT 1.0 cannot do arithmetic on lengths with units;
      update these if the page size or those margins change.
    -->
    <xsl:param name="body-usable-height">245mm</xsl:param>
    <xsl:param name="cover-usable-height">249mm</xsl:param>

    <!-- ==================================================================== -->
    <!--                         COMMON VARIABLES                              -->
    <!-- ==================================================================== -->
    <xsl:variable name="meta" select="/jssbook/bookmeta"/>
    <!--
      The running head (decisions.md ST8): the JSS0251 document type's short
      phrase (e.g. "Maintenance") when one has been chosen, falling back to
      the book's own free-text name otherwise — so a project with no document
      type set keeps rendering exactly as it always has.
    -->
    <xsl:variable name="book.name">
        <xsl:choose>
            <xsl:when test="$meta/documentTypeHeader != ''"><xsl:value-of select="$meta/documentTypeHeader"/></xsl:when>
            <xsl:when test="$meta/bookName != ''"><xsl:value-of select="$meta/bookName"/></xsl:when>
            <xsl:otherwise>Book Name</xsl:otherwise>
        </xsl:choose>
    </xsl:variable>
    <xsl:variable name="system.name">
        <xsl:choose>
            <xsl:when test="$meta/systemName != ''"><xsl:value-of select="$meta/systemName"/></xsl:when>
            <xsl:otherwise>System Name</xsl:otherwise>
        </xsl:choose>
    </xsl:variable>
    <xsl:variable name="classification">
        <xsl:choose>
            <xsl:when test="$security.classification != ''">
                <xsl:value-of select="$security.classification"/>
            </xsl:when>
            <xsl:when test="$meta/security != ''"><xsl:value-of select="$meta/security"/></xsl:when>
            <xsl:otherwise>RESTRICTED</xsl:otherwise>
        </xsl:choose>
    </xsl:variable>
    <!-- JSS alphanumeric sequence omits i, o and v to avoid confusion with
         roman numerals, matching the (a)(b)...(h)(j)(k) runs in the stencil. -->
    <xsl:variable name="jss.alpha.lower">abcdefghjklmnpqrstuwxyz</xsl:variable>
    <xsl:variable name="jss.alpha.upper">ABCDEFGHJKLMNPQRSTUWXYZ</xsl:variable>
    <!-- ================================================================ -->
    <!--  MARGIN NOTES  (mirrors the S1000D engine; same parameter names,   -->
    <!--  so one Settings tab drives both)                                  -->
    <!-- ================================================================ -->
    <xsl:param name="side.note.enabled">0</xsl:param>
    <xsl:param name="side.note.text"/>
    <xsl:param name="produced.by.enabled">0</xsl:param>
    <xsl:param name="produced.by.prefix">Produced by: </xsl:param>
    <xsl:param name="side.note.font.size">8pt</xsl:param>
    <xsl:param name="side.note.margin">7mm</xsl:param>
    <xsl:param name="side.note.length">110mm</xsl:param>
    <xsl:param name="side.note.top">35mm</xsl:param>
    <xsl:param name="produced.by.top"/>
    <xsl:param name="side.note.clearance">6mm</xsl:param>
    <!-- Height of the logo in the running head; 0 or empty suppresses it. -->
    <xsl:param name="header.logo.height">10mm</xsl:param>
    <!--
      How the TEXT of a NOTE / WARNING / CAUTION is set. Same names and same
      defaults as the S1000D engine, so a house style configured once reads
      the same whichever pipeline built the book.
    -->
    <xsl:param name="notice.text.caps">1</xsl:param>
    <xsl:param name="notice.text.bold">1</xsl:param>

    <xsl:variable name="lower">abcdefghijklmnopqrstuvwxyz</xsl:variable>
    <xsl:variable name="upper">ABCDEFGHIJKLMNOPQRSTUVWXYZ</xsl:variable>

    <!-- ==================================================================== -->
    <!--                         INCLUDE MODULES                               -->
    <!-- ==================================================================== -->
    <xsl:include href="pagesetup.xsl"/>
    <xsl:include href="headers_footers.xsl"/>
    <xsl:include href="common.xsl"/>
    <xsl:include href="tables.xsl"/>
    <xsl:include href="figures.xsl"/>
    <xsl:include href="warnings.xsl"/>
    <xsl:include href="toc.xsl"/>
    <xsl:include href="frontmatter.xsl"/>
    <xsl:include href="body.xsl"/>

    <!-- ==================================================================== -->
    <!--                         ROOT TEMPLATE                                 -->
    <!-- ==================================================================== -->
    <xsl:template match="/">
        <fo:root font-family="{$font-stack}" font-size="{$font-size}">
            <xsl:call-template name="layout-master-set"/>
            <xsl:call-template name="bookmark-tree"/>
            <xsl:apply-templates select="jssbook"/>
        </fo:root>
    </xsl:template>

    <xsl:template match="jssbook">
        <!-- Cover pages carry the classification banner and no running head -->
        <xsl:apply-templates select="frontmatter/titlePageJoint | frontmatter/titlePage"/>
        <!-- Roman-numbered prelims -->
        <xsl:call-template name="frontmatter-prelims"/>
        <!-- Arabic chapter-relative body -->
        <xsl:apply-templates select="body/chapter"/>
    </xsl:template>

    <!-- Unmatched elements fall through to their children rather than dumping
         raw text, so an unknown tag never corrupts the page. -->
    <xsl:template match="bookmeta"/>

</xsl:stylesheet>

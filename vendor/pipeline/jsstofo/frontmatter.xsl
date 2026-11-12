<?xml version="1.0" encoding="UTF-8"?>
<!-- ********************************************************************
     JSS to XSL-FO: Front matter

     Renders the fixed prelim pages of the stencil, in order:
       title page (joint) -> title page -> proprietary -> foreword ->
       record of changes -> associated handbooks -> safety warning ->
       first aid -> cautions/notes -> demolition -> change notice ->
       list of abbreviations -> contents / annexures / figures / tables ->
       system name -> description of symbols
     ******************************************************************** -->
<xsl:stylesheet xmlns:xsl="http://www.w3.org/1999/XSL/Transform" version="1.0"
  xmlns:fo="http://www.w3.org/1999/XSL/Format">

    <!--
      A JSS0251 document type's cover title (decisions.md ST8): one line for
      most types (e.g. "USER HANDBOOK"), several for others (e.g. MM's
      "TECHNICAL MANUAL" / "PART II MAINTENANCE") — content/jssDocTypes.js's
      own lines, carried here as <documentType><line>...</line>...</documentType>
      by engine/frontmatter.js (the same <line> convention the foreword's
      address block already uses). Older project.json still sends plain text
      (one <documentType>text</documentType>, no <line> children), so that
      case is kept exactly as it rendered before.
    -->
    <xsl:template name="document-type-title">
        <xsl:param name="node" select="documentType"/>
        <xsl:choose>
            <xsl:when test="$node/line">
                <xsl:for-each select="$node/line">
                    <fo:block>
                        <xsl:if test="position() != last()"><xsl:attribute name="space-after">2mm</xsl:attribute></xsl:if>
                        <xsl:value-of select="."/>
                    </fo:block>
                </xsl:for-each>
            </xsl:when>
            <xsl:otherwise><fo:block><xsl:value-of select="$node"/></fo:block></xsl:otherwise>
        </xsl:choose>
    </xsl:template>

    <!--
      Everything from the proprietary page onward is grouped into "parts",
      each its own page-sequence that opens on an odd (right-hand) page and
      pads itself to end even (see prelim-part-sequence in pagesetup.xsl) —
      the same right-hand-opening convention chapters use, applied to the
      front matter. Roman numbering still increments continuously across
      parts; only the grouping into separate sequences is new. Every named
      section gets its own part, including first aid and each of the
      contents/figures/tables/annexures pages, so each one individually opens
      on the right regardless of how long the section before it ran.

      The two cover pages (joint title, title) are emitted separately by the
      jssbook template because they use the banner layout and carry no folio;
      their own always-exactly-two-pages construction already guarantees the
      first prelim part below opens on a true odd page.
    -->

    <!--
      A page heading: the project's own wording when it has set one, otherwise
      the stencil's. Kept as a named template because XSLT cannot look a
      parameter up by name, so each call site has to pass its own override in.
    -->
    <!--
      A fixed piece of front-matter wording — a column heading, a caption, the
      run-in before a table. Prints the project's override when there is one
      and the stencil's own wording otherwise, so a book that sets nothing
      looks exactly as it did.

      Separate from fm-heading, which is only for a page's own title. These are
      the strings inside the page, and there are enough of them that the
      alternative — a parameter used once, hardcoded at its single call site —
      is what left every one of them uneditable.
    -->
    <xsl:template name="fm-label">
        <xsl:param name="override"/>
        <xsl:param name="default"/>
        <xsl:choose>
            <xsl:when test="normalize-space($override) != ''"><xsl:value-of select="$override"/></xsl:when>
            <xsl:otherwise><xsl:value-of select="$default"/></xsl:otherwise>
        </xsl:choose>
    </xsl:template>

    <xsl:template name="fm-heading">
        <xsl:param name="override"/>
        <xsl:param name="default"/>
        <xsl:choose>
            <xsl:when test="normalize-space($override) != ''"><xsl:value-of select="$override"/></xsl:when>
            <xsl:otherwise><xsl:value-of select="$default"/></xsl:otherwise>
        </xsl:choose>
    </xsl:template>

    <xsl:template name="frontmatter-prelims">
        <xsl:variable name="fm" select="frontmatter"/>
        <!--
          One page-sequence per front-matter page, in DOCUMENT ORDER.

          This used to name each page explicitly, in a fixed sequence, which
          meant the running order was hardcoded here as well as in the code that
          builds the frontmatter block — two lists to keep in step by hand. Now
          whatever the build puts in <frontmatter>, in whatever order, is what
          gets rendered, so turning a page off or moving it is a data change
          rather than a stylesheet change, and both engines follow the same
          list automatically.

          The two cover pages are excluded: they are emitted separately by the
          jssbook template because they use the banner layout and carry no
          folio.
        -->
        <xsl:for-each select="$fm/*[not(self::titlePageJoint or self::titlePage)]">
            <xsl:call-template name="prelim-part-sequence">
                <xsl:with-param name="content"><xsl:apply-templates select="."/></xsl:with-param>
                <xsl:with-param name="first">
                    <xsl:choose>
                        <xsl:when test="position() = 1">1</xsl:when>
                        <xsl:otherwise>0</xsl:otherwise>
                    </xsl:choose>
                </xsl:with-param>
            </xsl:call-template>
        </xsl:for-each>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                   1. TITLE PAGE (JOINTLY PUBLISHED)                   -->
    <!-- ==================================================================== -->
    <xsl:template match="titlePageJoint">
        <xsl:variable name="content">
            <fo:block text-align="right" font-weight="bold" space-after="3mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.titleJoint.publicationNo"/><xsl:with-param name="default">&lt;&lt;Publication No&gt;&gt;: </xsl:with-param></xsl:call-template>
                <xsl:value-of select="$meta/publicationNo"/>
            </fo:block>

            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block><xsl:apply-templates select="disclosureNotice/node()"/></fo:block>
                </xsl:with-param>
            </xsl:call-template>

            <xsl:call-template name="national-emblem"/>

            <fo:block text-align="center" font-weight="bold"
                      font-family="{$cover.title.font-family}" font-size="{$cover.title.font-size}" space-after="5mm">
                <xsl:call-template name="document-type-title"/>
                <fo:block space-before="3mm">FOR</fo:block>
                <fo:block space-before="5mm"><xsl:value-of select="$system.name"/></fo:block>
            </fo:block>

            <fo:block text-align="center" font-weight="bold" font-size="13pt" space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.titleJoint.nsn"/><xsl:with-param name="default">NSN: </xsl:with-param></xsl:call-template><xsl:value-of select="$meta/nsn"/>
            </fo:block>
            <fo:block text-align="center" font-weight="bold" font-size="13pt" space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.titleJoint.contractNo"/><xsl:with-param name="default">Contract No.: </xsl:with-param></xsl:call-template><xsl:value-of select="$meta/contractNo"/>
            </fo:block>
            <fo:block text-align="center" font-weight="bold" font-size="13pt" space-after="6mm">
                <xsl:text>(</xsl:text><xsl:value-of select="$meta/projectCode"/><xsl:text>)</xsl:text>
            </fo:block>

            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block><xsl:apply-templates select="repairNotice/node()"/></fo:block>
                </xsl:with-param>
            </xsl:call-template>

            <fo:block text-align="center" font-weight="bold" space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.titleJoint.publishedBy"/><xsl:with-param name="default">Jointly Prepared &amp; Published by:</xsl:with-param></xsl:call-template>
            </fo:block>
            <xsl:call-template name="publisher-row"/>
            <xsl:call-template name="authority-block"/>
        </xsl:variable>

        <xsl:call-template name="cover-page-sequence">
            <xsl:with-param name="content" select="$content"/>
        </xsl:call-template>
        <xsl:call-template name="cover-blank-verso"/>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                        2. TITLE PAGE (SINGLE)                         -->
    <!-- ==================================================================== -->
    <xsl:template match="titlePage">
        <xsl:variable name="content">
            <fo:block text-align="right" font-weight="bold" space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.inbrNo"/><xsl:with-param name="default">INBR No.:</xsl:with-param></xsl:call-template><xsl:value-of select="$meta/inbrNo"/>
            </fo:block>

            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block><xsl:apply-templates select="disclosureNotice/node()"/></fo:block>
                </xsl:with-param>
            </xsl:call-template>

            <xsl:call-template name="national-emblem"/>

            <fo:block text-align="center" font-weight="bold"
                      font-family="{$cover.title.font-family}" font-size="{$cover.title.font-size}"
                      text-decoration="underline" space-after="8mm">
                <xsl:call-template name="document-type-title"/>
            </fo:block>
            <fo:block text-align="center" font-weight="bold"
                      font-family="{$cover.title.font-family}" font-size="{$cover.title.font-size}"
                      text-decoration="underline" space-after="8mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.for"/><xsl:with-param name="default">FOR</xsl:with-param></xsl:call-template>
            </fo:block>
            <fo:block text-align="center" font-weight="bold"
                      font-family="{$cover.title.font-family}" font-size="{$cover.title.font-size}"
                      text-decoration="underline" space-after="8mm">
                <xsl:value-of select="$system.name"/>
            </fo:block>

            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block><xsl:apply-templates select="repairNotice/node()"/></fo:block>
                </xsl:with-param>
            </xsl:call-template>

            <fo:block text-align="center" space-before="6mm" space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.publishedBy"/><xsl:with-param name="default">Prepared &amp; Published by</xsl:with-param></xsl:call-template>
            </fo:block>
            <xsl:for-each select="$meta/publishers/publisher[1]">
                <xsl:if test="logo/@src">
                    <fo:block text-align="center" space-after="3mm">
                        <!-- logo/@width and @height, when set on this publisher in
                             Settings, override the built-in 20mm-tall/auto-width
                             default so a house with an unusually wide or tall mark
                             is not forced into it. -->
                        <fo:external-graphic src="url('{logo/@src}')" scaling="uniform">
                            <xsl:attribute name="content-height">
                                <xsl:choose>
                                    <xsl:when test="logo/@height"><xsl:value-of select="logo/@height"/></xsl:when>
                                    <xsl:otherwise>20mm</xsl:otherwise>
                                </xsl:choose>
                            </xsl:attribute>
                            <xsl:if test="logo/@width">
                                <xsl:attribute name="content-width"><xsl:value-of select="logo/@width"/></xsl:attribute>
                            </xsl:if>
                        </fo:external-graphic>
                    </fo:block>
                </xsl:if>
                <fo:block text-align="center">
                    <xsl:for-each select="name | addressLine">
                        <fo:block><xsl:value-of select="."/></fo:block>
                    </xsl:for-each>
                </fo:block>
            </xsl:for-each>

            <xsl:call-template name="authority-block"/>
        </xsl:variable>

        <xsl:call-template name="cover-page-sequence">
            <xsl:with-param name="content" select="$content"/>
        </xsl:call-template>
        <xsl:call-template name="cover-blank-verso"/>
    </xsl:template>

    <!-- Shared cover-page furniture -->
    <xsl:template name="national-emblem">
        <fo:block text-align="center" space-after="4mm">
            <xsl:choose>
                <xsl:when test="$meta/emblem/@src">
                    <fo:external-graphic src="url('{$meta/emblem/@src}')"
                                         content-height="28mm" scaling="uniform"/>
                </xsl:when>
                <xsl:otherwise>
                    <!-- Reserve the emblem's space when no artwork is supplied so
                         the page composition still matches the stencil. -->
                    <fo:block-container height="28mm" width="100%">
                        <fo:block/>
                    </fo:block-container>
                </xsl:otherwise>
            </xsl:choose>
        </fo:block>
    </xsl:template>

    <!--
      The joint title page holds 1, 2 or 3 publishers. The row always used a
      fixed 3-column table, so 1 publisher landed in the leftmost third (and
      looked left-aligned) and 2 publishers filled only the left two-thirds
      (and looked shifted left) instead of being centered as a group. Sizing
      the table to the actual publisher count fixes both: 1 publisher gets a
      single full-width centered cell, 2 publishers get two equal centered
      halves, and 3 publishers keep today's even three-way split.
    -->
    <xsl:template name="publisher-row">
        <xsl:variable name="pubCount" select="count($meta/publishers/publisher)"/>
        <!--
          Zero publishers used to fall through to the "otherwise" 3-column
          branch below and then for-each over an empty node-set: a
          <fo:table-row> with no cells at all, which XSL-FO forbids outright
          ("fo:table-row is missing child elements") and FOP refuses to
          render — not a cosmetic gap, a build that produces no PDF.
          Never hit by an ordinary project (branding.publishers always has at
          least the house default), first hit by a pmRef annex whose own
          branding was never configured, since its title page is generated
          from ITS OWN settings rather than the master's. Absent publishers
          now means no publisher block at all, matching "nothing configured,
          nothing shown" elsewhere in this front matter rather than a broken
          table.
        -->
        <xsl:if test="$pubCount &gt; 0">
        <fo:table table-layout="fixed" width="100%" space-after="6mm">
            <xsl:choose>
                <xsl:when test="$pubCount = 1">
                    <fo:table-column column-width="proportional-column-width(1)"/>
                </xsl:when>
                <xsl:when test="$pubCount = 2">
                    <fo:table-column column-width="proportional-column-width(1)"/>
                    <fo:table-column column-width="proportional-column-width(1)"/>
                </xsl:when>
                <xsl:otherwise>
                    <fo:table-column column-width="proportional-column-width(1)"/>
                    <fo:table-column column-width="proportional-column-width(1)"/>
                    <fo:table-column column-width="proportional-column-width(1)"/>
                </xsl:otherwise>
            </xsl:choose>
            <fo:table-body>
                <fo:table-row>
                    <xsl:for-each select="$meta/publishers/publisher">
                        <fo:table-cell padding="2mm" text-align="center">
                            <xsl:if test="logo/@src">
                                <fo:block space-after="2mm">
                                    <!-- Fitted inside a box: logos vary from
                                         square roundels to wide wordmarks, and
                                         constraining height alone lets a wide
                                         one overrun its column. The box itself
                                         is logo/@width x @height when set in
                                         Settings for this publisher, else the
                                         42mm x 18mm default. -->
                                    <fo:external-graphic src="url('{logo/@src}')"
                                                         content-width="scale-down-to-fit"
                                                         content-height="scale-down-to-fit"
                                                         scaling="uniform">
                                        <xsl:attribute name="width">
                                            <xsl:choose>
                                                <xsl:when test="logo/@width"><xsl:value-of select="logo/@width"/></xsl:when>
                                                <xsl:otherwise>42mm</xsl:otherwise>
                                            </xsl:choose>
                                        </xsl:attribute>
                                        <xsl:attribute name="height">
                                            <xsl:choose>
                                                <xsl:when test="logo/@height"><xsl:value-of select="logo/@height"/></xsl:when>
                                                <xsl:otherwise>18mm</xsl:otherwise>
                                            </xsl:choose>
                                        </xsl:attribute>
                                    </fo:external-graphic>
                                </fo:block>
                            </xsl:if>
                            <fo:block><xsl:value-of select="name"/></fo:block>
                            <xsl:for-each select="addressLine">
                                <fo:block><xsl:value-of select="."/></fo:block>
                            </xsl:for-each>
                        </fo:table-cell>
                    </xsl:for-each>
                </fo:table-row>
            </fo:table-body>
        </fo:table>
        </xsl:if>
    </xsl:template>

    <xsl:template name="authority-block">
        <fo:table table-layout="fixed" width="100%" space-before="6mm">
            <fo:table-column column-width="proportional-column-width(1)"/>
            <fo:table-column column-width="proportional-column-width(1)"/>
            <fo:table-body>
                <fo:table-row>
                    <fo:table-cell display-align="after">
                        <fo:block>
                            <xsl:value-of select="$meta/month"/>
                            <xsl:text>, </xsl:text>
                            <xsl:value-of select="$meta/year"/>
                        </fo:block>
                    </fo:table-cell>
                    <fo:table-cell text-align="right">
                        <!-- Agastya: project settings frontMatter.labels.title.authorityHeading
                             and .authority; the JSS wording is the default. An empty block
                             is left out so a project can drop the authority lines. -->
                        <xsl:variable name="authHead">
                            <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.authorityHeading"/><xsl:with-param name="default">Under the Authority of</xsl:with-param></xsl:call-template>
                        </xsl:variable>
                        <xsl:variable name="authLine">
                            <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.authority"/><xsl:with-param name="default">Secretary, Ministry of Defence, Govt. of India</xsl:with-param></xsl:call-template>
                        </xsl:variable>
                        <xsl:if test="normalize-space($authHead) != '-'"><fo:block><xsl:value-of select="$authHead"/></fo:block></xsl:if>
                        <xsl:if test="normalize-space($authLine) != '-'"><fo:block><xsl:value-of select="$authLine"/></fo:block></xsl:if>
                    </fo:table-cell>
                </fo:table-row>
            </fo:table-body>
        </fo:table>
    </xsl:template>

    <!-- Blank verso following a cover page keeps the banner but has no folio -->
    <xsl:template name="cover-blank-verso">
        <xsl:if test="$blank.versos = '1'">
            <xsl:call-template name="cover-page-sequence">
                <xsl:with-param name="content">
                    <fo:block-container height="{$cover-usable-height}" display-align="center">
                        <fo:block text-align="center" font-weight="bold">
                            <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.title.blankPage"/><xsl:with-param name="default">This page is intentionally left blank.</xsl:with-param></xsl:call-template>
                        </fo:block>
                    </fo:block-container>
                </xsl:with-param>
            </xsl:call-template>
        </xsl:if>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                   3. PROPRIETARY INFORMATION NOTICE                   -->
    <!-- ==================================================================== -->
    <xsl:template match="proprietary">
        <fo:block>
            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block text-align="center" font-weight="bold" font-size="{$heading2-size}"
                              space-after="5mm" text-decoration="underline">
                        <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.proprietary.heading"/><xsl:with-param name="default">RESTRICTION ON USE, DUPLICATION OR DISCLOSURE OF PROPRIETARY INFORMATION</xsl:with-param></xsl:call-template>
                    </fo:block>
                    <xsl:apply-templates select="para"/>
                </xsl:with-param>
            </xsl:call-template>
            <xsl:if test="applicability">
                <fo:block border="0.8pt solid #CC0000" padding="2mm" color="#CC0000"
                          margin-left="0mm" margin-right="0mm"
                          text-align="center" font-weight="bold">
                    <xsl:value-of select="applicability"/>
                </fo:block>
            </xsl:if>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                             4. FOREWORD                               -->
    <!-- ==================================================================== -->
    <xsl:template match="foreword">
        <fo:block break-before="page" border="0.8pt solid black" padding="4mm"
                  margin-left="0mm" margin-right="0mm">
            <fo:block text-align="center" font-weight="bold" font-size="{$heading2-size}"
                      space-after="4mm">
                <xsl:call-template name="fm-heading"><xsl:with-param name="override" select="$fm.title.foreword"/><xsl:with-param name="default">FOREWORD</xsl:with-param></xsl:call-template>
            </fo:block>
            <fo:block space-after="4mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.foreword.documentNo"/><xsl:with-param name="default">L&amp;T Document No.: </xsl:with-param></xsl:call-template>
                <xsl:value-of select="$meta/ltDocumentNo"/>
            </fo:block>
            <xsl:apply-templates select="para"/>
            <xsl:apply-templates select="deflist"/>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                         5. RECORD OF CHANGES                          -->
    <!-- ==================================================================== -->
    <xsl:template match="recordOfChanges">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.recordOfChanges"/>
                        <xsl:with-param name="default">RECORD OF CHANGES</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <!-- No width="100%": a percentage resolves against the containing
                 reference area, not against this table's padded, bordered
                 parent, so the table came out wider than the box that draws
                 the rule around it. Omitting it lets the table take the
                 parent's actual content width. -->
            <fo:table table-layout="fixed" font-size="{$table-font-size}">
                <fo:table-column column-width="proportional-column-width(1.2)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(2.6)"/>
                <fo:table-column column-width="proportional-column-width(1.1)"/>
                <fo:table-header>
                    <fo:table-row font-weight="bold">
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.roc.colChangeNotice"/><xsl:with-param name="default">Change Notice No.</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.roc.colAuthority"/><xsl:with-param name="default">Authority</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.roc.colIncorporatedBy"/><xsl:with-param name="default">Incorporated by "Name &amp; Rank" in block letters</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.roc.colInitials"/><xsl:with-param name="default">Initials with Date</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                    </fo:table-row>
                </fo:table-header>
                <fo:table-body>
                    <fo:table-row>
                        <xsl:call-template name="roc-cell"><xsl:with-param name="t">(1)</xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-cell"><xsl:with-param name="t">(2)</xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-cell"><xsl:with-param name="t">(3)</xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-cell"><xsl:with-param name="t">(4)</xsl:with-param></xsl:call-template>
                    </fo:table-row>
                    <xsl:call-template name="empty-rows">
                        <xsl:with-param name="count">
                            <xsl:choose>
                                <xsl:when test="@rows"><xsl:value-of select="@rows"/></xsl:when>
                                <xsl:otherwise>20</xsl:otherwise>
                            </xsl:choose>
                        </xsl:with-param>
                        <xsl:with-param name="cols">4</xsl:with-param>
                    </xsl:call-template>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <xsl:template name="roc-head">
        <xsl:param name="t"/>
        <fo:table-cell border="0.6pt solid black" padding="1.5mm">
            <fo:block text-align="center"><xsl:value-of select="$t"/></fo:block>
        </fo:table-cell>
    </xsl:template>

    <xsl:template name="roc-cell">
        <xsl:param name="t"/>
        <fo:table-cell border="0.6pt solid black" padding="1.5mm">
            <fo:block text-align="center"><xsl:value-of select="$t"/></fo:block>
        </fo:table-cell>
    </xsl:template>

    <!-- Emits N blank ruled rows; used by the pro-forma tables -->
    <xsl:template name="empty-rows">
        <xsl:param name="count"/>
        <xsl:param name="cols"/>
        <xsl:if test="$count &gt; 0">
            <fo:table-row height="7mm">
                <xsl:call-template name="empty-cells">
                    <xsl:with-param name="cols" select="$cols"/>
                </xsl:call-template>
            </fo:table-row>
            <xsl:call-template name="empty-rows">
                <xsl:with-param name="count" select="$count - 1"/>
                <xsl:with-param name="cols" select="$cols"/>
            </xsl:call-template>
        </xsl:if>
    </xsl:template>

    <xsl:template name="empty-cells">
        <xsl:param name="cols"/>
        <xsl:if test="$cols &gt; 0">
            <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                <fo:block>&#160;</fo:block>
            </fo:table-cell>
            <xsl:call-template name="empty-cells">
                <xsl:with-param name="cols" select="$cols - 1"/>
            </xsl:call-template>
        </xsl:if>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                       6. ASSOCIATED HANDBOOKS                         -->
    <!-- ==================================================================== -->
    <xsl:template match="associatedHandbooks">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.associatedHandbooks"/>
                        <xsl:with-param name="default">ASSOCIATED HANDBOOKS</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <fo:block space-after="3mm">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.handbooks.introBefore"/><xsl:with-param name="default">Technical literature for </xsl:with-param></xsl:call-template>
                <fo:inline font-weight="bold">
                    <xsl:text>"</xsl:text><xsl:value-of select="$system.name"/><xsl:text>"</xsl:text>
                </fo:inline>
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.handbooks.introAfter"/><xsl:with-param name="default"> comprises of the following:</xsl:with-param></xsl:call-template>
            </fo:block>
            <fo:table table-layout="fixed" width="100%" font-size="{$table-font-size}">
                <fo:table-column column-width="18mm"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="35mm"/>
                <fo:table-header>
                    <fo:table-row font-weight="bold">
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.handbooks.colSr"/><xsl:with-param name="default">Sr. No.</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.handbooks.colTitle"/><xsl:with-param name="default">Document Title</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.handbooks.colInbr"/><xsl:with-param name="default">INBR No.</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                    </fo:table-row>
                </fo:table-header>
                <fo:table-body>
                    <xsl:for-each select="handbook">
                        <fo:table-row>
                            <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                                <fo:block text-align="center"><xsl:value-of select="@sr"/></fo:block>
                            </fo:table-cell>
                            <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                                <fo:block><xsl:value-of select="title"/></fo:block>
                            </fo:table-cell>
                            <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                                <fo:block><xsl:value-of select="inbr"/></fo:block>
                            </fo:table-cell>
                        </fo:table-row>
                    </xsl:for-each>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                          7. SAFETY WARNING                            -->
    <!-- ==================================================================== -->
    <xsl:template match="safetyWarning">
        <fo:block break-before="page">
            <xsl:call-template name="red-box">
                <xsl:with-param name="align">center</xsl:with-param>
                <xsl:with-param name="content">
                    <fo:block font-weight="bold" font-size="{$heading2-size}" space-after="4mm"
                              text-decoration="underline">
                        <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.safety.heading"/><xsl:with-param name="default">SAFETY WARNING</xsl:with-param></xsl:call-template>
                    </fo:block>
                    <xsl:for-each select="line">
                        <fo:block>
                            <xsl:if test="@emphasis = 'strong'">
                                <xsl:attribute name="font-weight">bold</xsl:attribute>
                            </xsl:if>
                            <xsl:if test="@space-before">
                                <xsl:attribute name="space-before"><xsl:value-of select="@space-before"/></xsl:attribute>
                            </xsl:if>
                            <xsl:apply-templates/>
                        </fo:block>
                    </xsl:for-each>
                </xsl:with-param>
            </xsl:call-template>
            <fo:block text-align="center" font-weight="bold" text-decoration="underline">
                <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.safety.footer"/><xsl:with-param name="default">FOR FIRST AID IN CASE OF ELECTRIC SHOCK SEE THE FOLLOWING PAGE</xsl:with-param></xsl:call-template>
            </fo:block>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--             8. FIRST AID IN CASE OF ELECTRIC SHOCK                    -->
    <!-- ==================================================================== -->
    <xsl:template match="firstAid">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.firstAid"/>
                        <xsl:with-param name="default">FIRST AID IN CASE OF ELECTRIC SHOCK</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <!--
              As in the stencil: the single illustration on the left (it already
              carries all four figures and their labels), unruled, with the
              numbered steps ruled as a grid on the right. The image cell spans
              every step row plus the closing row.

              The rule belongs to the step grid itself, NOT to a wrapper block
              around the whole page. Wrapping it meant a width="100%" table
              inside a padded, bordered block — and a percentage width resolves
              against the containing reference area, not against that padded
              parent, so the table came out wider than the box drawing the rule
              and punched straight through it (six FOP overflow warnings on this
              page alone). Letting the cells carry the border removes the
              nesting the two disagreed about.
            -->
            <fo:table table-layout="fixed" width="100%" font-size="{$table-font-size}">
                <!-- The artwork column follows the artwork, plus its 2mm gutter.
                     Fixed at 36mm it did not: narrowing the picture left a
                     36mm hole instead of giving the step text more width, so
                     the image-width setting appeared to do nothing. -->
                <fo:table-column column-width="{concat($firstaid.image.width, ' + 4mm')}"/>
                <fo:table-column column-width="8mm"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-body>
                    <xsl:for-each select="step">
                        <fo:table-row>
                            <!-- Emitted once, on the first row, spanning the rest.
                                 The span includes the closing row so that the
                                 closing statement can start in column 2 and stay
                                 inside the ruled grid instead of running under
                                 the artwork. -->
                            <xsl:if test="position() = 1">
                                <fo:table-cell padding-right="2mm" display-align="before"
                                               number-rows-spanned="{count(../step) + count(../closing)}">
                                    <fo:block>
                                        <!-- Settings win over the stencil's default src, so a
                                             project can supply its own artwork without editing
                                             the shipped stencil. -->
                                        <xsl:variable name="src">
                                            <xsl:choose>
                                                <xsl:when test="$firstaid.image != ''"><xsl:value-of select="$firstaid.image"/></xsl:when>
                                                <xsl:otherwise><xsl:value-of select="../figure/@src"/></xsl:otherwise>
                                            </xsl:choose>
                                        </xsl:variable>
                                        <xsl:if test="$src != ''">
                                            <!--
                                              Sized to FILL the page, not to a fixed 32mm width.
                                              This artwork is a tall strip (about 1:3.6) and its
                                              cell spans every row, so it is what sets the height
                                              of the whole block: at 32mm wide it came out 115mm
                                              tall and left the bottom third of the page empty.
                                              Both dimensions are given and the scaling is uniform,
                                              so the picture grows as large as fits inside them and
                                              keeps its proportions whatever artwork is supplied.
                                            -->
                                            <fo:external-graphic src="url('{$src}')"
                                                                 width="{$firstaid.image.width}"
                                                                 height="{$firstaid.image.height}"
                                                                 content-width="scale-to-fit"
                                                                 content-height="scale-to-fit"
                                                                 scaling="uniform"/>
                                        </xsl:if>
                                    </fo:block>
                                </fo:table-cell>
                            </xsl:if>
                            <fo:table-cell padding="1.5mm" border="0.6pt solid black"
                                           display-align="before">
                                <fo:block><xsl:value-of select="position()"/><xsl:text>.</xsl:text></fo:block>
                            </fo:table-cell>
                            <fo:table-cell padding="1.5mm" border="0.6pt solid black">
                                <xsl:apply-templates select="para"/>
                            </fo:table-cell>
                        </fo:table-row>
                    </xsl:for-each>
                    <xsl:if test="closing">
                        <fo:table-row>
                            <!-- Columns 2-3 only: column 1 is still covered by the
                                 artwork's row span above. -->
                            <fo:table-cell number-columns-spanned="2" padding="1.5mm"
                                           border="0.6pt solid black">
                                <fo:block font-weight="bold" text-align="justify">
                                    <xsl:value-of select="closing"/>
                                </fo:block>
                            </fo:table-cell>
                        </fo:table-row>
                    </xsl:if>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <!-- First-aid step paragraphs are justified, as in the stencil -->
    <xsl:template match="step/para">
        <fo:block space-after="1.5mm" text-align="justify"><xsl:apply-templates/></fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                          9. CAUTIONS / NOTES                          -->
    <!-- ==================================================================== -->
    <xsl:template match="cautionsNotes">
        <fo:block break-before="page">
            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block text-align="center" font-weight="bold" font-size="{$heading2-size}"
                              space-after="4mm" text-decoration="underline">
                        <xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.cautions.heading"/><xsl:with-param name="default">CAUTIONS/ NOTES</xsl:with-param></xsl:call-template>
                    </fo:block>
                    <fo:list-block provisional-distance-between-starts="10mm"
                                   provisional-label-separation="2mm">
                        <xsl:for-each select="item">
                            <fo:list-item space-after="2mm">
                                <fo:list-item-label end-indent="label-end()">
                                    <fo:block font-weight="bold">
                                        <xsl:value-of select="position()"/><xsl:text>.</xsl:text>
                                    </fo:block>
                                </fo:list-item-label>
                                <fo:list-item-body start-indent="body-start()">
                                    <fo:block font-weight="bold"><xsl:apply-templates/></fo:block>
                                </fo:list-item-body>
                            </fo:list-item>
                        </xsl:for-each>
                    </fo:list-block>
                </xsl:with-param>
            </xsl:call-template>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--            10. DEMOLITION OF MATERIAL TO PREVENT ENEMY USE            -->
    <!-- ==================================================================== -->
    <xsl:template match="demolition">
        <fo:block break-before="page">
            <xsl:call-template name="red-box">
                <xsl:with-param name="content">
                    <fo:block text-align="center" font-weight="bold" font-size="{$heading2-size}"
                              space-after="4mm" text-decoration="underline">
                        <xsl:call-template name="fm-heading"><xsl:with-param name="override" select="$fm.title.demolition"/><xsl:with-param name="default">DEMOLITION OF MATERIAL TO PREVENT ENEMY USE</xsl:with-param></xsl:call-template>
                    </fo:block>
                    <xsl:for-each select="part">
                        <fo:block font-weight="bold" space-before="3mm" space-after="1mm">
                            <xsl:text>(</xsl:text>
                            <xsl:call-template name="jss-alpha">
                                <xsl:with-param name="n" select="position()"/>
                            </xsl:call-template>
                            <xsl:text>)&#160;&#160;</xsl:text>
                            <xsl:value-of select="title"/>
                        </fo:block>
                        <fo:block margin-left="8mm">
                            <xsl:apply-templates select="*[not(self::title)]"/>
                        </fo:block>
                    </xsl:for-each>
                </xsl:with-param>
            </xsl:call-template>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                          11. CHANGE NOTICE                            -->
    <!-- ==================================================================== -->
    <xsl:template match="changeNotice">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.changeNotice"/>
                        <xsl:with-param name="default">CHANGE NOTICE</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <xsl:if test="$meta/publishers/publisher[1]/logo/@src">
                <fo:block space-after="3mm">
                    <fo:external-graphic src="url('{$meta/publishers/publisher[1]/logo/@src}')"
                                         content-height="10mm" scaling="uniform"/>
                    <fo:inline font-weight="bold" font-style="italic" font-size="{$heading2-size}">
                        <xsl:text>  </xsl:text>
                        <xsl:value-of select="$meta/publishers/publisher[1]/name"/>
                    </fo:inline>
                </fo:block>
            </xsl:if>

            <fo:table table-layout="fixed" width="100%" font-size="{$table-font-size}" space-after="6mm">
                <fo:table-column column-width="proportional-column-width(1.3)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="proportional-column-width(1.2)"/>
                <fo:table-header>
                    <!-- Header words are long relative to the column width, so
                         this row is set a step smaller to avoid overflow. -->
                    <fo:table-row font-weight="bold" font-size="8.5pt">
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.change.colTitle"/><xsl:with-param name="default">TITLE OF PUBLICATION</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.change.colCode"/><xsl:with-param name="default">CODE NO. AND DATE</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.change.colPrevious"/><xsl:with-param name="default">PREVIOUS CHANGE</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.change.colNoticeNo"/><xsl:with-param name="default">CHANGE NOTICE NO. AND DATE</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                    </fo:table-row>
                </fo:table-header>
                <fo:table-body>
                    <xsl:call-template name="empty-rows">
                        <xsl:with-param name="count">
                            <xsl:choose>
                                <xsl:when test="@rows"><xsl:value-of select="@rows"/></xsl:when>
                                <xsl:otherwise>3</xsl:otherwise>
                            </xsl:choose>
                        </xsl:with-param>
                        <xsl:with-param name="cols">4</xsl:with-param>
                    </xsl:call-template>
                </fo:table-body>
            </fo:table>

            <fo:block text-align="right" space-after="6mm">
                <fo:block>No. of Pages&#160;&#160;:</fo:block>
                <fo:block>No. of Sheets&#160;:</fo:block>
                <fo:block>Enclosures&#160;&#160;&#160;&#160;:</fo:block>
            </fo:block>

            <fo:table table-layout="fixed" width="100%" font-size="{$table-font-size}">
                <fo:table-column column-width="proportional-column-width(1.6)"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-body>
                    <fo:table-row>
                        <fo:table-cell border="0.6pt solid black" padding="2mm">
                            <fo:block font-weight="bold" space-after="2mm">CODES FOR INCORPORATION OF CHANGES:</fo:block>
                            <fo:block space-after="1.5mm"><fo:inline font-weight="bold">(R)</fo:inline> By Replacement/ addition of sheet(s)</fo:block>
                            <fo:block space-after="1.5mm"><fo:inline font-weight="bold">(H)</fo:inline> By Hand-correction</fo:block>
                            <fo:block space-after="1.5mm"><fo:inline font-weight="bold">(P)</fo:inline> By pasting the enclosed matter</fo:block>
                            <fo:block><fo:inline font-weight="bold">(A)</fo:inline> Additional information - only to be filed in the publication</fo:block>
                        </fo:table-cell>
                        <fo:table-cell border="0.6pt solid black" padding="2mm">
                            <fo:block font-weight="bold" space-after="2mm">NOTE:</fo:block>
                            <fo:block>This document should be filed/ pasted in the copy of the Publication before the CONTENTS Page. After carrying out (R), (H) or (P) entry should be made in Record of Changes Page.</fo:block>
                        </fo:table-cell>
                    </fo:table-row>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                      12. LIST OF ABBREVIATIONS                        -->
    <!-- ==================================================================== -->
    <xsl:template match="listOfAbbreviations">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.listOfAbbreviations"/>
                        <xsl:with-param name="default">LIST OF ABBREVIATIONS</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <fo:table table-layout="fixed" width="100%" font-size="{$table-font-size}">
                <fo:table-column column-width="50mm"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-header>
                    <fo:table-row font-weight="bold">
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.abbrev.colTerm"/><xsl:with-param name="default">Abbreviations</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                        <xsl:call-template name="roc-head"><xsl:with-param name="t"><xsl:call-template name="fm-label"><xsl:with-param name="override" select="$fm.label.abbrev.colMeaning"/><xsl:with-param name="default">Description</xsl:with-param></xsl:call-template></xsl:with-param></xsl:call-template>
                    </fo:table-row>
                </fo:table-header>
                <fo:table-body>
                    <xsl:choose>
                        <xsl:when test="abbreviation">
                            <!--
                              Alphabetical, not as authored. A list of
                              abbreviations is looked things up in, never read
                              through, so the only order that helps a reader is
                              the one they can search by eye.

                              Sorted on the term folded to capitals, because
                              XSLT 1.0 sorts by code point: unfolded, every
                              lower-case term would file after every upper-case
                              one and "mm" would sit below "ZZ".
                            -->
                            <xsl:for-each select="abbreviation">
                                <xsl:sort select="translate(@term, $lower, $upper)"/>
                                <fo:table-row>
                                    <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                                        <fo:block font-weight="bold"><xsl:value-of select="@term"/></fo:block>
                                    </fo:table-cell>
                                    <fo:table-cell border="0.6pt solid black" padding="1.5mm">
                                        <fo:block><xsl:value-of select="."/></fo:block>
                                    </fo:table-cell>
                                </fo:table-row>
                            </xsl:for-each>
                        </xsl:when>
                        <xsl:otherwise>
                            <xsl:call-template name="empty-rows">
                                <xsl:with-param name="count">9</xsl:with-param>
                                <xsl:with-param name="cols">2</xsl:with-param>
                            </xsl:call-template>
                        </xsl:otherwise>
                    </xsl:choose>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                        13. SYSTEM NAME PAGE                           -->
    <!-- ==================================================================== -->
    <xsl:template match="systemNamePage">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text" select="translate($system.name, $lower, $upper)"/>
            </xsl:call-template>
            <xsl:choose>
                <!--
                  Drawn here rather than handed to the graphic template,
                  which bounds a picture by the FIGURE caps — the limits meant
                  for illustrations inside the text. A system illustration is
                  a page of its own and usually wants to be larger, so it has
                  its own bounds, defaulting to the figure caps so an
                  untouched project looks exactly as it did.

                  Bounds, not sizes: scaling stays uniform, so several
                  pictures of different shapes each grow as large as fit and
                  keep their proportions.
                -->
                <xsl:when test="graphic/@src">
                    <xsl:for-each select="graphic">
                        <fo:block text-align="center" space-after="4mm">
                            <!-- Both dimensions given, not a max-height:
                                 max-height caps the viewport and not the
                                 picture, which FOP then draws past the box
                                 and over whatever follows. -->
                            <fo:external-graphic src="url('{@src}')"
                                                 width="{$systemimage.max.width}"
                                                 height="{$systemimage.max.height}"
                                                 content-width="scale-down-to-fit"
                                                 content-height="scale-down-to-fit"
                                                 scaling="uniform"/>
                        </fo:block>
                    </xsl:for-each>
                </xsl:when>
                <xsl:when test="figure | graphic | image">
                    <xsl:apply-templates select="figure | graphic | image"/>
                </xsl:when>
                <xsl:otherwise>
                    <!-- Empty ruled frame reserving the system illustration area -->
                    <fo:block-container height="200mm" border="0.8pt solid black">
                        <fo:block/>
                    </fo:block-container>
                </xsl:otherwise>
            </xsl:choose>
        </fo:block>
    </xsl:template>

    <!-- ==================================================================== -->
    <!--                     14. DESCRIPTION OF SYMBOLS                        -->
    <!-- ==================================================================== -->
    <!--
      Two-column page: hazard symbols on the left, notice-box legends on the
      right, exactly as the stencil lays it out.
    -->
    <xsl:template match="descriptionOfSymbols">
        <fo:block break-before="page">
            <xsl:call-template name="page-title">
                <xsl:with-param name="text">
                    <xsl:call-template name="fm-heading">
                        <xsl:with-param name="override" select="$fm.title.descriptionOfSymbols"/>
                        <xsl:with-param name="default">DESCRIPTION OF SYMBOLS</xsl:with-param>
                    </xsl:call-template>
                </xsl:with-param>
            </xsl:call-template>
            <fo:table table-layout="fixed" width="100%">
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-column column-width="6mm"/>
                <fo:table-column column-width="proportional-column-width(1)"/>
                <fo:table-body>
                    <fo:table-row>
                        <!-- Left column: hazard symbols. A project with no symbols
                             (e.g. a software SOP) must still emit a block here, or
                             the table-cell is left childless, which FOP rejects. -->
                        <fo:table-cell>
                            <xsl:choose>
                                <xsl:when test="symbolList/symbol">
                                    <xsl:for-each select="symbolList/symbol">
                                        <fo:block space-after="4mm">
                                            <fo:table table-layout="fixed" width="100%">
                                                <fo:table-column column-width="14mm"/>
                                                <fo:table-column column-width="proportional-column-width(1)"/>
                                                <fo:table-body>
                                                    <fo:table-row>
                                                        <fo:table-cell display-align="center">
                                                            <fo:block>
                                                                <xsl:choose>
                                                                    <xsl:when test="@src">
                                                                        <fo:external-graphic src="url('{@src}')"
                                                                                             content-width="10mm"
                                                                                             scaling="uniform"/>
                                                                    </xsl:when>
                                                                    <xsl:otherwise>
                                                                        <fo:block-container height="10mm" width="10mm"
                                                                                            border="0.6pt solid black">
                                                                            <fo:block/>
                                                                        </fo:block-container>
                                                                    </xsl:otherwise>
                                                                </xsl:choose>
                                                            </fo:block>
                                                        </fo:table-cell>
                                                        <fo:table-cell display-align="center" padding-left="2mm">
                                                            <fo:block font-size="{$table-font-size}">
                                                                <xsl:apply-templates/>
                                                            </fo:block>
                                                        </fo:table-cell>
                                                    </fo:table-row>
                                                </fo:table-body>
                                            </fo:table>
                                        </fo:block>
                                    </xsl:for-each>
                                </xsl:when>
                                <xsl:otherwise><fo:block/></xsl:otherwise>
                            </xsl:choose>
                        </fo:table-cell>

                        <fo:table-cell><fo:block/></fo:table-cell>

                        <!-- Right column: NOTE / WARNING / CAUTION legends -->
                        <fo:table-cell>
                            <xsl:apply-templates select="noticeList/*"/>
                        </fo:table-cell>
                    </fo:table-row>
                </fo:table-body>
            </fo:table>
        </fo:block>
    </xsl:template>

</xsl:stylesheet>

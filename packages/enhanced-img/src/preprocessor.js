import MagicString from 'magic-string';
import { asyncWalk } from 'estree-walker';
import { parse } from 'svelte-parse-markup';

const ASSET_PREFIX = '___ASSET___';

// TODO: expose this in vite-imagetools rather than duplicating it
const OPTIMIZABLE = /^[^?]+\.(avif|heif|gif|jpeg|jpg|png|tiff|webp)(\?.*)?$/;

/**
 * @param {{
 *   plugin_context: import('rollup').PluginContext
 *   imagetools_plugin: import('vite').Plugin
 * }} opts
 * @returns {import('svelte/types/compiler/preprocess').PreprocessorGroup}
 */
export function image(opts) {
	// TODO: clear this map in dev mode to avoid memory leak
	/**
	 * URL to image details
	 * @type {Map<string, { image: import('vite-imagetools').Picture, name: string }>}
	 */
	const images = new Map();

	return {
		async markup({ content, filename }) {
			if (!content.includes('<enhanced:img')) {
				return;
			}

			const s = new MagicString(content);
			const ast = parse(content, { filename });

			/**
			 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
			 * @param {{ type: string, start: number, end: number, raw: string }} src_attribute
			 * @returns {Promise<void>}
			 */
			async function update_element(node, src_attribute) {
				// TODO: this will become ExpressionTag in Svelte 5
				if (src_attribute.type === 'MustacheTag') {
					const src_var_name = content
						.substring(src_attribute.start + 1, src_attribute.end - 1)
						.trim();
					s.update(node.start, node.end, dynamic_img_to_picture(content, node, src_var_name));
					return;
				}

				let url = src_attribute.raw.trim();

				const sizes = get_attr_value(node, 'sizes');
				const width = get_attr_value(node, 'width');
				url += url.includes('?') ? '&' : '?';
				if (sizes) {
					url += 'imgSizes=' + encodeURIComponent(sizes.raw) + '&';
				}
				if (width) {
					url += 'imgWidth=' + encodeURIComponent(width.raw) + '&';
				}
				url += 'enhanced';

				let details = images.get(url);
				if (!details) {
					// resolves the import so that we can build the entire picture template string and don't
					// need any logic blocks
					const image = await resolve(opts, url, filename);
					if (!image) {
						return;
					}
					details = images.get(url) || { name: ASSET_PREFIX + images.size, image };
					images.set(url, details);
				}

				if (OPTIMIZABLE.test(url)) {
					s.update(node.start, node.end, img_to_picture(content, node, details));
				} else {
					// e.g. <img src="./foo.svg" /> => <img src="{___ASSET___0}" />
					s.update(src_attribute.start, src_attribute.end, `{${details}}`);
				}
			}

			// TODO: switch to zimmerframe with Svelte 5
			// @ts-ignore
			await asyncWalk(ast.html, {
				/**
				 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
				 */
				async enter(node) {
					if (node.type === 'Element') {
						// Compare node tag match
						if (node.name === 'enhanced:img') {
							const src = get_attr_value(node, 'src');
							if (!src) return;
							await update_element(node, src);
						}
					}
				}
			});

			return {
				code: s.toString(),
				map: s.generateMap()
			};
		}
	};
}

/**
 * @param {{
 *   plugin_context: import('rollup').PluginContext
 *   imagetools_plugin: import('vite').Plugin
 * }} opts
 * @param {string} url
 * @param {string | undefined} importer
 * @returns {Promise<import('vite-imagetools').Picture | undefined>}
 */
async function resolve(opts, url, importer) {
	const resolved = await opts.plugin_context.resolve(url, importer);
	const id = resolved?.id;
	if (!id) {
		return;
	}
	if (!opts.imagetools_plugin.load) {
		throw new Error('Invalid instance of vite-imagetools. Could not find load method.');
	}
	const hook = opts.imagetools_plugin.load;
	const handler = typeof hook === 'object' ? hook.handler : hook;
	const module_info = await handler.call(opts.plugin_context, id);
	if (!module_info) {
		throw new Error(`Could not load ${id}`);
	}
	const code = typeof module_info === 'string' ? module_info : module_info.code;
	return parseObject(code.replace('export default', '').replace(/;$/, '').trim());
}

/**
 * @param {string} str
 */
export function parseObject(str) {
	const updated = str
		.replaceAll(/{(\n\s*)?/gm, '{"')
		.replaceAll(':', '":')
		.replaceAll(/,(\n\s*)?([^ ])/g, ',"$2');
	try {
		return JSON.parse(updated);
	} catch (err) {
		throw new Error(`Failed parsing string to object: ${str}`);
	}
}

/**
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} attr
 */
function get_attr_value(node, attr) {
	const attribute = node.attributes.find(
		/** @param {any} v */ (v) => v.type === 'Attribute' && v.name === attr
	);

	if (!attribute) return;

	return attribute.value[0];
}

/**
 * @param {string} content
 * @param {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes
 * @param {{
 *   src: string,
 *   width: string | number,
 *   height: string | number
 * }} details
 */
function img_attributes_to_markdown(content, attributes, details) {
	const attribute_strings = attributes.map((attribute) => {
		if (attribute.name === 'src') {
			return `src=${details.src}`;
		}
		return content.substring(attribute.start, attribute.end);
	});

	/** @type {number | undefined} */
	let user_width;
	/** @type {number | undefined} */
	let user_height;
	for (const attribute of attributes) {
		if (attribute.name === 'width') user_width = parseInt(attribute.value[0]);
		if (attribute.name === 'height') user_height = parseInt(attribute.value[0]);
	}
	if (!user_width && !user_height) {
		attribute_strings.push(`width=${details.width}`);
		attribute_strings.push(`height=${details.height}`);
	} else if (!user_width && user_height) {
		attribute_strings.push(
			`width=${Math.round(
				(stringToNumber(details.width) * user_height) / stringToNumber(details.height)
			)}`
		);
	} else if (!user_height && user_width) {
		attribute_strings.push(
			`height=${Math.round(
				(stringToNumber(details.height) * user_width) / stringToNumber(details.width)
			)}`
		);
	}

	return attribute_strings.join(' ');
}

/**
 * @param {string|number} param
 */
function stringToNumber(param) {
	return typeof param === 'string' ? parseInt(param) : param;
}

/**
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {{ image: import('vite-imagetools').Picture, name: string }} details
 */
function img_to_picture(content, node, details) {
	/** @type {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes */
	const attributes = node.attributes;
	const index = attributes.findIndex((attribute) => attribute.name === 'sizes');
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = ' ' + content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	let res = '<picture>';
	for (const [format, srcset] of Object.entries(details.image.sources)) {
		res += `<source srcset="${srcset}"${sizes_string} type="image/${format}" />`;
	}
	res += `<img ${img_attributes_to_markdown(content, attributes, {
		src: details.image.img.src,
		width: details.image.img.w,
		height: details.image.img.h
	})} />`;
	res += '</picture>';
	return res;
}

/**
 * For images like `<img src={manually_imported} />`
 * @param {string} content
 * @param {import('svelte/types/compiler/interfaces').TemplateNode} node
 * @param {string} src_var_name
 */
function dynamic_img_to_picture(content, node, src_var_name) {
	/** @type {Array<import('svelte/types/compiler/interfaces').BaseDirective | import('svelte/types/compiler/interfaces').Attribute | import('svelte/types/compiler/interfaces').SpreadAttribute>} attributes */
	const attributes = node.attributes;
	const index = attributes.findIndex((attribute) => attribute.name === 'sizes');
	let sizes_string = '';
	if (index >= 0) {
		sizes_string = ' ' + content.substring(attributes[index].start, attributes[index].end);
		attributes.splice(index, 1);
	}

	const details = {
		src: `{${src_var_name}.img.src}`,
		width: `{${src_var_name}.img.w}`,
		height: `{${src_var_name}.img.h}`
	};

	return `{#if typeof ${src_var_name} === 'string'}
	<img ${img_attributes_to_markdown(content, node.attributes, details)} />
{:else}
	<picture>
		{#each Object.entries(${src_var_name}.sources) as [format, srcset]}
			<source {srcset}${sizes_string} type={'image/' + format} />
		{/each}
		<img ${img_attributes_to_markdown(content, attributes, details)} />
	</picture>
{/if}`;
}

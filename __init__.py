"""ComfyUI-QwenImageExpand

1) Qwen 图像扩展（Image Expand）：只做灰度扩边画布的可视化编辑器（导入图片 / 拖动矩形外扩 /
   延伸区域填充 rgb(128,128,128)）+ IMAGE 输出。
2) Qwen 2.1 扩图（Outpaint All-in-One）：把「加载模型 + 扩边 + 编码 + 采样 + 解码 + 存盘」
   收成一个节点，内嵌同一个编辑器。
"""

from .nodes import NODE_CLASS_MAPPINGS as EXPAND_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as EXPAND_NAMES
from .pipeline import NODE_CLASS_MAPPINGS as PIPE_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS as PIPE_NAMES

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {**EXPAND_MAPPINGS, **PIPE_MAPPINGS}
NODE_DISPLAY_NAME_MAPPINGS = {**EXPAND_NAMES, **PIPE_NAMES}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
